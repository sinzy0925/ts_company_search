import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import axios from 'axios';

// -----------------------------------------------------------------------------
// 0. 初期設定と型定義
// -----------------------------------------------------------------------------

dotenv.config();

interface SuccessResponse {
  status: "success";
  report: object;
  auditLog: string[];
}
interface ErrorResponse {
  status: "error";
  message: string;
  auditLog: string[];
}
type AgentResponse = SuccessResponse | ErrorResponse;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("環境変数 GEMINI_API_KEY が設定されていません。");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// -----------------------------------------------------------------------------
// 1. エージェントのコア機能
// -----------------------------------------------------------------------------

async function companyAgent(companyName: string): Promise<AgentResponse> {
  const auditLog: string[] = [];
  const log = (message: string) => {
    console.log(message);
    auditLog.push(message);
  };

  log(`\n==================================================`);
  log(`エージェント起動: 対象 = "${companyName}"`);
  log(`==================================================`);

  try {
    // --- ステップ1: 公式サイトURLの特定 ---
    log(`\n[ステップ1] 公式サイトURL特定プロセス開始...`);
    
    const findUrlPrompt = `
      あなたは、与えられた企業名から公式サイトのURLだけを返す、高精度なシステムです。
     【重要指示】
      # 制約解除 : 予算はふんだんにあるから、思いっきり実行すること。
      # googleSearch を使用してください。
      # 一度の思考で失敗しても、仮説＝＞検証を何度も繰り返し、可能な限り出力内容を探してください。
      # ３回探しても公式サイトが見当たらない場合のみ、大文字で「NONE」と返してください。
      # 以下の例のように、必ずURLのみを出力してください。説明や他のテキストは一切不要です。
      [例1]
      入力: 株式会社トヨタ自動車
      出力: https://global.toyota/jp/
      [例2]
      入力: 存在しない会社あｓｄｆｇ
      出力: NONE
      [本番]
      入力: ${companyName}
      出力:
    `;
    
    // ▼▼▼【あなたの指示を反映：動的思考を有効化】▼▼▼
    const urlResult = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: findUrlPrompt }] }],
      config: { 
        tools: [{ googleSearch: {} }], 
        temperature: 0.0,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: -1 // 動的思考を有効に
        }
      },
    });

    if (urlResult.candidates && urlResult.candidates.length > 0) {
        for (const candidate of urlResult.candidates) {
            if (candidate.content && candidate.content.parts) {
                for (const part of candidate.content.parts) {
                    if (part.thought) {
                        log(`  > [AIの思考ログ - ステップ1] \n---\n${part.text}\n---`);
                    }
                }
            }
        }
    }

    const urlText = urlResult.text;
    log(`  > [AIの最終応答] モデルからの生応答（URL特定）: "${urlText}"`);

    if (typeof urlText !== 'string' || urlText.trim() === '' || urlText.trim().toUpperCase() === 'NONE') {
      log(`  > [AIの能力限界] モデルは公式サイトを特定できませんでした。`);
      return { status: "error", message: "決定的な公式サイトが見つかりませんでした...", auditLog };
    }
    
    const urlMatches = urlText.match(/https?:\/\/[^\s"<>]+/g);
    
    if (!urlMatches || urlMatches.length === 0) {
       log(`  > [プログラムの失敗] モデルの応答からURLを抽出できませんでした。`);
       return { status: "error", message: `公式サイトのURLを特定できませんでした...`, auditLog };
    }
    
    const uniqueUrls = [...new Set(urlMatches)];
    let initialUrl = uniqueUrls[0];
    initialUrl = initialUrl.replace(/[.,\)]+$/, "");
    log(`  > [プログラムの成果] 抽出・クリーンアップされたURL: ${initialUrl}`);
    
    log(`\n[ステップ1.5] リダイレクト解決プロセス開始...`);
    let finalUrl = initialUrl;
    if (initialUrl.includes("vertexaisearch.cloud.google.com")) {
        try {
            const response = await axios.get(initialUrl, { maxRedirects: 5 });
            finalUrl = response.request.res.responseUrl || initialUrl;
            log(`  > [プログラムの成果] リダイレクトを解決しました。`);
        } catch (redirectError) {
            log(`  > [プログラムの失敗] リダイレクトの解決に失敗しました。`);
            finalUrl = initialUrl;
        }
    }
    log(`  > [確定情報] 最終的な公式サイトURL: ${finalUrl}`);

    // --- ステップ2: 詳細情報をJSONで抽出 ---
    log(`\n[ステップ2] 詳細情報抽出プロセス開始...`);
    const extractInfoPrompt = `
      【役割】あなたは指定されたウェブサイトを分析し、その結果をJSON形式で出力する専門家です。
      【重要指示】
      # 制約解除 : 予算はふんだんにあるから、思いっきり実行すること。
      # ツールの優先度 まず、# googleSearch を使うこと。 必要があると判断したら、# urlContext を使うこと。
      # 一度の思考で失敗しても、仮説＝＞検証を何度も繰り返し、可能な限り出力内容を探してください。
      # ツール（googleSearch, urlContext）の呼び出しが、合計で３回を超えても全ての情報が見つからない場合は、その時点で分かっている情報だけでJSONを作成し、作業を完全に停止せよ。
      # 会社名、「会社概要」、「企業情報」、「About Us」などのキーワードを使って、googleSearchで情報を探すこと。
      # 最初に特定した公式サイトの情報と、googleSearchで見つかった情報が明らかに別の会社のものであると判断した場合は、その時点で調査を完全に終了させよ。予算の無駄になる。      
      - HTMLのaタグを確認して、メールアドレスを抽出してください。
      - 調査結果を、必ず下記のJSON構造に厳密に従って出力してください。
      - 出力は、JSONオブジェクトのみとし、前後に説明文や\`\`\`jsonのようなマークダウンを一切含めないでください。
      【調査対象URL】
      ${finalUrl}
      【出力JSON構造】
      {
        "companyName": "企業の正式名称（string）",
        "officialUrl": "公式サイトのURL（string）",
        "address": "本社の所在地（string）",
        "Email": "代表メールアドレス（string）",
        "capital": "出資金額（string）",
        "start": "創業年月（string）",
        "businessSummary": "主要な事業内容の要約（string）",
        "strengths": "競合と比較した企業の強みや独自性（string）"
      }
    `;


    // ▼▼▼【あなたの指示を反映：こちらでも動的思考を有効化】▼▼▼
    const jsonResult = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: extractInfoPrompt }] }],
      config: {
        tools: [{ urlContext: {} },{ googleSearch: {} }],
        thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: -1 // 動的思考を有効に
        }
      }
    });

    log('extractInfoPrompt')
    log(extractInfoPrompt)

    if (jsonResult.candidates && jsonResult.candidates.length > 0) {
        for (const candidate of jsonResult.candidates) {
            if (candidate.content && candidate.content.parts) {
                for (const part of candidate.content.parts) {
                    if (part.thought) {
                        log(`  > [AIの思考ログ - ステップ2] \n---\n${part.text}\n---`);
                    }
                }
            }
        }
    }

    const responseText = jsonResult.text;
    log(`  > [AIの最終応答] モデルからの生応答（JSON抽出）: ${responseText}`);
    
    if (typeof responseText !== 'string' || responseText === '') {
      log(`  > [AIの能力限界] モデルはテキストを生成できませんでした。Finish Reason: ${jsonResult.candidates?.[0]?.finishReason}`);
      throw new Error("The text part of the JSON response from the model was empty.");
    }
    
    const jsonMatch = responseText.match(/{[\s\S]*}/);
    const jsonString = jsonMatch ? jsonMatch[0] : null;

    if (!jsonString) {
      log(`  > [プログラムの失敗] モデルの応答からJSONオブジェクトを抽出できませんでした。`);
      throw new Error("Failed to extract a valid JSON object from the model's response.");
    }
    log(`  > [プログラムの成果] 応答からJSON部分を抽出しました。`);

    let parsedJson;
    try {
        parsedJson = JSON.parse(jsonString);
    } catch(e) {
        log(`  > [プログラムの失敗] 抽出されたJSON文字列のパースに失敗しました。`);
        throw new Error("Failed to parse the extracted JSON string.");
    }

    if (parsedJson.error) {
        log(`  > [AIの能力限界] モデルは意図的にエラーを報告しました: ${parsedJson.error}`);
        return { status: "error", message: `レポートを生成できませんでした。モデルからの報告: ${parsedJson.error}`, auditLog };
    }

    log(`\n[成功] レポート生成完了！`);
    return { status: "success", report: parsedJson, auditLog };

  } catch (error) {
    log(`\n[致命的エラー] エージェント実行中に予期せぬエラーが発生しました。`);
    console.error(error);
    return { status: "error", message: `レポートの生成中にエラーが発生しました。サーバーのログを確認してください。`, auditLog };
  }
}

// -----------------------------------------------------------------------------
// 2. Webサーバー機能
// -----------------------------------------------------------------------------
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());
app.post('/api/agent', async (req: Request, res: Response) => {
  const { companyName } = req.body;
  if (!companyName || typeof companyName !== 'string') {
    return res.status(400).json({ status: "error", message: 'companyName (string) is required', auditLog: [] });
  }
  const result = await companyAgent(companyName);
  if (result.status === 'error') {
    return res.status(500).json(result);
  }
  return res.status(200).json(result);
});
app.listen(port, () => {
  console.log(`サーバーが http://localhost:${port} で起動しました`);
  console.log(`curl -X POST -H "Content-Type: application/json" -d '{"companyName": "株式会社メルカリ"}' http://localhost:3000/api/agent`);
  console.log(`テストするには、新しいターミナルで以下のcurlコマンドを実行してください:\n`);
});