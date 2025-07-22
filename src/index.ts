import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// -----------------------------------------------------------------------------
// 0. 初期設定と型定義
// -----------------------------------------------------------------------------

dotenv.config();

const KNOWLEDGE_BASE_PATH = path.join(__dirname, 'knowledge-base.json');

interface ReportData {
  companyName: string;
  officialUrl: string;
  address: string;
  Industry?: string;
  Email?: string;
  TEL?: string;
  FAX?: string;
  capital?: string;
  'Founding date'?: string;
  businessSummary: string;
  strengths: string;
  [key: string]: any;
}

interface KnowledgeBaseEntry {
  companyName: string;
  officialUrl: string;
  step1Thoughts: string[];
  report?: ReportData;
  lastUpdated: string;
}

interface KnowledgeBase {
  [companyName: string]: KnowledgeBaseEntry;
}

interface SuccessResponse {
  status: "success";
  report: ReportData;
  source: "cache" | "live";
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
// 1. 知識ベース（記憶）の操作関数
// -----------------------------------------------------------------------------

function loadKnowledgeBase(log: (message: string) => void): KnowledgeBase {
  try {
    if (fs.existsSync(KNOWLEDGE_BASE_PATH)) {
      const fileContent = fs.readFileSync(KNOWLEDGE_BASE_PATH, 'utf-8');
      if (fileContent) {
        return JSON.parse(fileContent);
      }
    }
    log("  > [記憶] 知識ベースファイルが存在しないか空のため、新しい記憶を開始します。");
    return {};
  } catch (error) {
    log(`  > [記憶エラー] 知識ベースの読み込みに失敗しました: ${error}`);
    return {};
  }
}

function saveKnowledgeBase(knowledgeBase: KnowledgeBase, log: (message: string) => void) {
  try {
    fs.writeFileSync(KNOWLEDGE_BASE_PATH, JSON.stringify(knowledgeBase, null, 2));
    log("  > [記憶] 新しい知識を知識ベースに保存しました。");
  } catch (error) {
    log(`  > [記憶エラー] 知識ベースの保存に失敗しました: ${error}`);
  }
}

// -----------------------------------------------------------------------------
// 2. エージェントのコア機能
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

  log(`\n[フェーズ1] 記憶の参照プロセス開始...`);
  const knowledgeBase = loadKnowledgeBase(log);
  const normalizedCompanyName = companyName.trim();
  if (knowledgeBase[normalizedCompanyName] && knowledgeBase[normalizedCompanyName].report) {
    log(`  > [記憶] 過去の完全な調査記録を発見しました！キャッシュから応答します。`);
    log(`\n[成功] レポート生成完了！（キャッシュより）`);
    return {
      status: "success",
      report: knowledgeBase[normalizedCompanyName].report!,
      source: "cache",
      auditLog
    };
  }
  log(`  > [記憶] 過去の調査記録はありません。ライブ調査に移行します。`);

  try {
    log(`\n[フェーズ2, ステップ1] 公式サイトURL特定プロセス開始...`);
    
    const findUrlPrompt = `
    // [SYSTEM INSTRUCTIONS - ENGLISH]
    // ROLE: You are a high-precision corporate investigator. Your mission is to find the official website URL for a given company name AND its exact address.
    // CRITICAL RULES:
    // 1. You MUST use the googleSearch tool. Your search queries must be in Japanese and include both the company name and the address.
    // 2. Your ONLY GOAL is to find a website that contains an address that is an EXACT or VERY CLOSE match to the input address.
    // 3. If you find a potential website, you MUST first verify its address. If the address does not match the input address, DISCARD that website immediately, even if the name is similar.
    // 4. If you cannot find a website that strictly matches the provided address on the first page of search results, you MUST return the single, uppercase word "NONE".
    // 5. Your final output MUST be ONLY the URL itself or the word "NONE". Do not include any other text.
    // 6. Think in English.
  
    // [EXAMPLES]
    // Input: 株式会社トヨタ自動車 愛知県豊田市トヨタ町1番地
    // Output: https://global.toyota/jp/
  
    // Input: 株式会社むらまつ 大阪府大阪市西成区花園北２丁目６番６号
    // Output: NONE
  
    // [TASK]
    // Input: ${companyName}
    // Output:
  `;
  
  /*
    【日本語訳】
    // [システム指示 - 英語]
    // 役割： あなたは、与えられた企業名「と」「その正確な住所」に対する、公式サイトのURLを見つけ出す、高精度な企業調査官です。
    //【最重要ルール】
    // 1. あなたは必ずgoogleSearchツールを使わなければならない。検索クエリは日本語で、会社名と住所の両方を含めなさい。
    // 2. あなたの唯一の目標は、入力された住所と「完全一致」または「極めて酷似」する住所を含んだウェブサイトを見つけることである。
    // 3. もしウェブサイトの候補を見つけたら、あなたはまずその住所を確認しなければならない。もし住所が入力住所と一致しないなら、たとえ名前が似ていても、そのウェブサイトは即座に棄却せよ。
    // 4. もし、提供された住所と厳密に一致するウェブサイトを、検索結果の1ページ目で見つけられない場合は、必ず、大文字の単語「NONE」を返しなさい。
    // 5. あなたの最終的な出力は、URLそのもの、または単語「NONE」の、どちらか「のみ」でなければならない。その他のテキストを一切含めてはいけない。
    // 6. 思考は英語で行いなさい。
  */
    
    log('findUrlPrompt');
    log(findUrlPrompt);

    const urlResult = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: findUrlPrompt }] }],
      config: { 
        tools: [{ googleSearch: {} }], 
        temperature: 0.0,
      },
    });

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
    
    log(`\n[フェーズ2, ステップ1.5] リダイレクト解決プロセス開始...`);
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

    log(`\n[フェーズ2, ステップ2] 詳細情報抽出プロセス開始...`);
    const extractInfoPrompt = `
    // [SYSTEM INSTRUCTIONS - ENGLISH]
    // ROLE: You are an elite business analyst. Your mission is to create a factual report using ONLY the googleSearch tool.
    // CRITICAL RULES:
    // 1. Your primary mission is to investigate the company associated with the "TARGET URL". Use Japanese keywords like "会社概要", "企業情報" combined with the company name to find the most accurate information.
    // 2. Your final output MUST be ONLY a JSON object that strictly adheres to the "OUTPUT JSON STRUCTURE".
    // 3. For any information that cannot be found through your search, you MUST use the Japanese phrase "情報なし".
    // 4. Think in English. Your search queries and final JSON values MUST be in Japanese.

    // [TARGET URL - Use this as your primary clue]
    // ${finalUrl}

    // [OUTPUT JSON STRUCTURE]
    // {
    //   "companyName": "企業の正式名称（string）",
    //   "officialUrl": "公式サイトのURL（string）",
    //   "address": "本社の所在地（string）",
    //   "Industry": "業界（string）",
    //   "Email": "メールアドレス（string）",
    //   "TEL": "電話番号（string）",
    //   "FAX": "ファックス（string）",
    //   "capital": "出資金額（string）",
    //   "Founding date": "創業年月（string）",
    //   "businessSummary": "主要な事業内容の要約（string）",
    //   "strengths": "競合と比較した企業の強みや独自性（string）"
    // }
  `;
    /*
    【日本語訳】
    // [システム指示 - 英語]
    // 役割： あなたはシニアビジネスアナリストです。あなたの任務は、提供された公式サイト「のみ」に基づいて、事実に基づいたレポートを作成することです。
    //【最重要ルール】
    // - あなたの唯一の情報源は、「ターゲットURL」にあるウェブサイトです。いかなる外部知識、以前の検索結果、その他のウェブサイトも使用してはいけません。与えられたURLに書かれている事実に、忠実でありなさい。
    // - ウェブサイト上で見つけることができない情報については、必ず、日本語のフレーズ「情報なし」またはそれに類する中立的な表現を、値として使用しなければなりません。
    */

    log('extractInfoPrompt');
    log(extractInfoPrompt);

    // ▼▼▼【ここが、最後の「ネットワークエラー」を解決する、最終ロジックです】▼▼▼
    let jsonResult;
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log(`  > [AIへの問い合わせ試行 ${attempt}/${maxRetries}]...`);
        jsonResult = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [{ text: extractInfoPrompt }] }],
          config: {
            tools: [{ googleSearch: {} }],//, {urlContext: {}}],
            safetySettings: [
              { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
              { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            ]
          }
        });
        log(`  > [試行 ${attempt} 成功] AIサーバーからの応答を取得しました。`);
        break; 
      } catch (error: any) {
        log(`  > [試行 ${attempt} 失敗] エラーが発生しました: ${error.message}`);
        if (attempt === maxRetries) {
          log(`  > [リトライ上限] 最大試行回数に達しました。`);
          throw error;
        }
        log(`  > 10秒待機して再試行します...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }

    if (!jsonResult) {
        throw new Error("API call failed after all retries.");
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

    let parsedJson: ReportData;
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

    log(`\n[フェーズ3] 記憶の形成プロセス開始...`);
    const newKnowledgeEntry: Omit<KnowledgeBaseEntry, 'step1Thoughts'> & { step1Thoughts?: string[] } = {
        companyName: normalizedCompanyName,
        officialUrl: finalUrl,
        report: parsedJson,
        lastUpdated: new Date().toISOString()
    };
    // For simplicity, we are not passing step1Thoughts to step2 in this version,
    // so we don't save it to the knowledge base either.
    knowledgeBase[normalizedCompanyName] = newKnowledgeEntry as KnowledgeBaseEntry;
    saveKnowledgeBase(knowledgeBase, log);

    log(`\n[成功] レポート生成完了！（ライブ調査より）`);
    return { 
      status: "success",
      report: parsedJson,
      source: "live",
      auditLog
    };

  } catch (error: any) {
    log(`\n[致命的エラー] エージェント実行中に予期せぬエラーが発生しました。`);
    let errorMessage = "レポートの生成中にエラーが発生しました。サーバーのログを確認してください。";
    if (error.message && (error.message.includes('fetch failed') || error.message.includes('RESOURCE_EXHAUSTED'))) {
        errorMessage = "ネットワークエラー、またはAPIの利用制限により、AIサーバーとの通信に失敗しました。Cloud Shellの制約、一時的なネットワークの問題、またはAPIの無料利用枠の上限に達した可能性があります。";
    }
    console.error(error);
    return { status: "error", message: errorMessage, auditLog };
  }
}

// -----------------------------------------------------------------------------
// 3. コマンドライン実行
// -----------------------------------------------------------------------------

async function main() {
  const companyName = process.argv.slice(2).join(' ');

  if (!companyName) {
    console.error("エラー: 会社名を引数として指定してください。");
    console.log("例: ts-node src/index.ts 株式会社メルカリ");
    process.exit(1);
  }

  const result = await companyAgent(companyName);

  if (result.status === 'success') {
    console.log("\n--- 最終レポート ---");
    console.log(JSON.stringify(result.report, null, 2));
  } else {
    console.error("\n--- エラー ---");
    console.error(result.message);
  }

  console.log("\n--- 監査ログ ---");
  console.log(result.auditLog.join('\n'));
}

main().catch(error => {
  console.error("\n[スクリプト致命的エラー] 実行に失敗しました。", error);
  process.exit(1);
});