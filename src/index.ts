import { GoogleGenAI, HarmCategory, HarmBlockThreshold, Content, CountTokensResponse } from "@google/genai";
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

// ReportDataの型を厳密に定義
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

// 知識ベースに「思考ログ」を保存する領域を追加
interface KnowledgeBaseEntry {
  companyName: string;
  officialUrl: string;
  step1Thoughts: string[]; // ステップ1の思考ログ
  report?: ReportData;      // ステップ2のレポート (オプション)
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

// 新SDKの作法でクライアントを初期化
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

  const step1token: number[] = [];
  const step2token: number[] = [];

  const totalStartTime = process.hrtime.bigint();

  log(`\n==================================================`);
  log(`エージェント起動: 対象 = "${companyName}"`);
  log(`==================================================`);

  log(`\n[フェーズ1] 記憶の参照プロセス開始...`);
  const knowledgeBase = loadKnowledgeBase(log);
  const normalizedCompanyName = companyName.trim();
  if (knowledgeBase[normalizedCompanyName] && knowledgeBase[normalizedCompanyName].report) {
    log(`  > [記憶] 過去の完全な調査記録を発見しました！キャッシュから応答します。`);
    const totalEndTime = process.hrtime.bigint();
    const totalDuration = Number(totalEndTime - totalStartTime) / 1_000_000_000;
    log(`\n[成功] レポート生成完了！（キャッシュより） - 合計処理時間: ${totalDuration.toFixed(2)}秒`);
    return {
      status: "success",
      report: knowledgeBase[normalizedCompanyName].report!,
      source: "cache",
      auditLog
    };
  }
  log(`  > [記憶] 過去の調査記録はありません。ライブ調査に移行します。`);

  try {
    const step1StartTime = process.hrtime.bigint();
    log(`\n[フェーズ2, ステップ1] 公式サイトURL特定プロセス開始...`);
    
    const findUrlPrompt = `
    // [SYSTEM INSTRUCTIONS - 日本語]
    // === 中核となるミッションと理念 ===
    // あなたの最も重要かつ主要な任務は、ユーザーが提供した会社名と住所に完全に一致するURLを見つけることです。
    // 異なる会社名や住所のURLを提供すると、ユーザーを混乱させることになるため、これは絶対に避けなければなりません。
    // ユーザーの入力内容と完全に一致するURLが見つからない場合は、直ちに「NONE」を返さなければなりません。
    //
    // 役割：あなたは高精度の企業調査員です。あなたの使命は、与えられた会社名と正確な住所から、その企業の公式ウェブサイトのURLを見つけ出すことです。
    //
    // 絶対的な重要ルール：
    // 1. あなたは、googleSearchとurlContextという2つのツールを利用できます。
    // 2. 最初のステップは、googleSearchを使用してウェブサイトのURL候補を見つけることです。検索クエリは日本語で行い、住所と会社名に加えて「会社概要」のようなキーワードを含める必要があります。
    // 3. googleSearchがURL候補（リダイレクトURLも含む）を提示した場合、次のステップとしてそのURLに対してurlContextツールを使用し、その内容を検証します。
    // 4. あなたの唯一の目標は、urlContextを使い、ウェブサイトの内容に含まれる住所が、入力された住所と完全に一致するか、または文字列として非常に近い一致であることを確認することです。
    // 5. ウェブサイト上で見つかった会社名と住所が、ユーザーの入力（${companyName}）と完全に一致するか、非常に近い一致である場合にのみ、URLを出力することが許可されます。「非常に近い」とは、軽微な書式の違いのみを指します。会社名や都市が異なる場合は、検証失敗となります。
    // 6. 情報の不一致に関する特別プロトコル： 住所は一致するものの、会社名がわずかに異なる（例：屋号や通称名）状況に遭遇した場合、あなたは最後の追加検索として、googleSearchを一度だけ実行することが許可されます。この二次検索では、ウェブサイトで見つかった新しいキーワード（屋号など）を使い、2つの会社が同一の事業体であることを裏付ける客観的な第三者の証拠（例：ニュース記事、企業ディレクトリ）を見つけなければなりません。そのような決定的な証拠が見つかった場合にのみ、そのサイトを「一致」と判断することが許可されます。
    // 7. urlContextを介して一致する住所が確認できた場合は、確認済みのURLを出力しなければなりません。
    // 8. ウェブサイト候補が見つからない場合、またはurlContextで一致する住所の確認に失敗した場合は、大文字の単語「NONE」のみを返さなければなりません。
    // 9. 最終的な出力は、URLそのものか、単語「NONE」のいずれかでなければなりません。
    // 10. 思考は英語で行わなければなりません。
    // [例]
    // 入力: 株式会社トヨタ自動車 愛知県豊田市トヨタ町1番地
    // 出力: https://global.toyota/jp/
    // 入力: 株式会社むらまつ 大阪府大阪市西成区花園北２丁目６番６号
    // 出力: NONE
    // [タスク]
    // 入力: ${companyName}
    // 出力:
    `;
    
    log("# [step1 findUrlPrompt]")
    log(findUrlPrompt)

    const urlResult = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: findUrlPrompt }] }],
      config: { 
        tools: [{ googleSearch: {} },{urlContext: {}}], 
        temperature: 0.0,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: -1
        }
      },
    });

    const step1Thoughts: string[] = [];
    if (urlResult.candidates && urlResult.candidates.length > 0) {
        for (const candidate of urlResult.candidates) {
            if (candidate.content && candidate.content.parts) {
                for (const part of candidate.content.parts) {
                    if (part.thought && typeof part.text === 'string') {
                        const thoughtText = `  > [AIの思考ログ - ステップ1] \n---\n${part.text}\n---`;
                        log(thoughtText);
                        step1Thoughts.push(thoughtText);
                    }
                }
            }
        }
    }
    
    //log(`\n--- [ステップ1 トークン会計] ---`);
    if (urlResult.usageMetadata) {
        const { promptTokenCount, candidatesTokenCount, totalTokenCount } = urlResult.usageMetadata;
        
        let thoughtTokenCount = 0;
        if (urlResult.candidates && urlResult.candidates.length > 0) {
            for (const candidate of urlResult.candidates) {
                if (candidate.content && candidate.content.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.thought) {
                            const thoughtTokens: CountTokensResponse = await ai.models.countTokens({
                                model: "gemini-2.5-flash",
                                contents: [{ role: "model", parts: [part] }]
                            });
                            if (typeof thoughtTokens.totalTokens === 'number') {
                                thoughtTokenCount += thoughtTokens.totalTokens;
                            }
                        }
                    }
                }
            }
        }
        
        const outputTokenCount = (totalTokenCount ?? 0) - (promptTokenCount ?? 0) - thoughtTokenCount;
        step1token.push(promptTokenCount ?? 0);
        step1token.push(thoughtTokenCount ??0);
        step1token.push(outputTokenCount ??0);
        step1token.push(totalTokenCount ??0);

    }

    const urlText = urlResult.text;
    log(`  > [AIの最終応答] モデルからの生応答（URL特定）: "${urlText}"`);

    if (typeof urlText !== 'string' || urlText.trim() === '' || urlText.trim().toUpperCase() === 'NONE') {
      log(`  > [AIの能力限界] モデルは、与えられた情報に一致する公式サイトを特定できませんでした。`);
      return { status: "error", message: "指定された会社名と住所に一致する、信頼できる公式サイトが見つかりませんでした。入力情報をご確認ください。", auditLog };
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
    
    const step1EndTime = process.hrtime.bigint();
    const step1Duration = Number(step1EndTime - step1StartTime) / 1_000_000_000;

    const step1_5_StartTime = process.hrtime.bigint();
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
    const step1_5_EndTime = process.hrtime.bigint();
    const step1_5_Duration = Number(step1_5_EndTime - step1_5_StartTime) / 1_000_000_000;

    const step2StartTime = process.hrtime.bigint();
    log(`\n[フェーズ2, ステップ2] 詳細情報抽出プロセス開始...`);
    const extractInfoPrompt = `
    // [SYSTEM INSTRUCTIONS - ENGLISH]
    // ROLE: You are an elite business analyst. Your mission is to create a factual intelligence report by leveraging all available tools.
    //
    // ABSOLUTE CRITICAL RULES:
    // 1.  Your primary investigation target is the company associated with the "TARGET URL". This URL is your most important clue.
    // 2.  You are equipped with two powerful tools: googleSearch and urlContext. You are authorized to use them as you see fit to accomplish your mission.
    // 3.  A recommended strategy is to first use googleSearch to gather broad information and identify key pages (like "会社概要","アクセス","お問い合わせ","連絡先"). If you find a direct, credible page, you should then use urlContext to perform a deep analysis of that specific page.
    // 4.  To find the "Email", you MUST pay special attention to pages with Japanese names like "お問い合わせ" (Contact Us) or "連絡先" (Contact Info). If you find such a page, meticulously inspect its HTML source for any "<a>" tags containing a "mailto:" link, as this is a high-probability indicator of an email address # use urlContext.
    // 5.  You MUST critically verify all information. Ensure that any data gathered via googleSearch truly belongs to the company at the "TARGET URL". Cross-reference facts like the address to avoid hallucinations.
    // 6.  Your final output MUST be ONLY a JSON object that strictly adheres to the "OUTPUT JSON STRUCTURE". Do not include any introductory text, concluding remarks, or markdown like \`\`\`json.
    // 7.  For any information that cannot be found after a thorough investigation using all your tools, you MUST use the Japanese phrase "情報なし". Do not guess or fabricate information.
    // 8.  You MUST think in English. Your search queries and final JSON values MUST be in Japanese, as you are reporting to a Japanese client.
    // ---
      // [JUNIOR AGENT'S THOUGHT LOG (Context for URL identification)]
      // ${step1Thoughts.join('\n\n')}
      // ---

      // [TARGET URL]
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


    const jsonResult = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: extractInfoPrompt }] }],
      config: {
        tools: [{ googleSearch: {} },{urlContext: {}}], 
        temperature: 0.0,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: -1
        },
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
        ]
      }
    });


    const step2Thoughts: string[] = [];
    if (jsonResult.candidates && jsonResult.candidates.length > 0) {
      for (const candidate of jsonResult.candidates) {
          if (candidate.content && candidate.content.parts) {
              for (const part of candidate.content.parts) {
                  if (part.thought && typeof part.text === 'string') {
                      const thoughtText = `  > [AIの思考ログ - ステップ2] \n---\n${part.text}\n---`;
                      //log(thoughtText);
                      step2Thoughts.push(thoughtText);
                  }
              }
          }
      }
    }

    //log(`\n--- [ステップ2 トークン会計] ---`);
    if (jsonResult.usageMetadata) {
        const { promptTokenCount, candidatesTokenCount, totalTokenCount } = jsonResult.usageMetadata;
        
        let thoughtTokenCount = 0;
        if (jsonResult.candidates && jsonResult.candidates.length > 0) {
            for (const candidate of jsonResult.candidates) {
                if (candidate.content && candidate.content.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.thought) {
                            const thoughtTokens: CountTokensResponse = await ai.models.countTokens({
                                model: "gemini-2.5-flash",
                                contents: [{ role: "model", parts: [part] }]
                            });
                            if (typeof thoughtTokens.totalTokens === 'number') {
                                thoughtTokenCount += thoughtTokens.totalTokens;
                            }
                        }
                    }
                }
            }
        }
        
        const outputTokenCount = (totalTokenCount ?? 0) - (promptTokenCount ?? 0) - thoughtTokenCount;
        step2token.push(promptTokenCount ?? 0);
        step2token.push(thoughtTokenCount ??0);
        step2token.push(outputTokenCount ??0);
        step2token.push(totalTokenCount ??0);
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

    const step2EndTime = process.hrtime.bigint();
    const step2Duration = Number(step2EndTime - step2StartTime) / 1_000_000_000;

    log(`\n[フェーズ3] 記憶の形成プロセス開始...`);
    const newKnowledgeEntry: KnowledgeBaseEntry = {
        companyName: normalizedCompanyName,
        officialUrl: finalUrl,
        step1Thoughts: step1Thoughts,
        report: parsedJson,
        lastUpdated: new Date().toISOString()
    };
    knowledgeBase[normalizedCompanyName] = newKnowledgeEntry;
    saveKnowledgeBase(knowledgeBase, log);

    const totalEndTime = process.hrtime.bigint();
    const totalDuration = Number(totalEndTime - totalStartTime) / 1_000_000_000;

    log('\n\n---\n\n# [step1 findUrlPrompt]');
    log(findUrlPrompt);
    log('\n\n---\n\n# [step1 AI Thoughts]');
    for (const thought of step1Thoughts) {
      log(thought);
    }

    log('\n\n---\n\n# [step2 extractInfoPrompt]');
    log(extractInfoPrompt);

    log('\n\n---\n\n# [step2 AI Thoughts]');
    for (const thought of step2Thoughts) {
      log(thought);
    }


    log(`\n\n---\n\n[成功] レポート生成完了！（ライブ調査より）`);
    log(` > [ステップ1 完了]   処理時間: ${step1Duration.toFixed(2)}秒`);
    log(` > [ステップ1.5 完了] 処理時間: ${step1_5_Duration.toFixed(2)}秒`);
    log(` > [ステップ2 完了]   処理時間: ${step2Duration.toFixed(2)}秒`);
    log(` > [全ステップ 完了]  処理時間: ${totalDuration.toFixed(2)}秒`);


    log(`\n--- [ステップ1 トークン会計] ---`);
    log(`  > 入力トークン (Prompt Tokens): ${step1token[0]}`);
    log(`  > 思考トークン (Thought Tokens): ${step1token[1]}`);
    log(`  > 出力トークン (Final Output Tokens): ${step1token[2]}`);
    log(`  > -----------------------------------`);
    log(`  > 合計トークン (Total Tokens): ${step1token[3]}`);
    log(`\n--- [ステップ2 トークン会計] ---`);
    log(`  > 入力トークン (Prompt Tokens): ${step2token[0]}`);
    log(`  > 思考トークン (Thought Tokens): ${step2token[1]}`);
    log(`  > 出力トークン (Final Output Tokens): ${step2token[2]}`);
    log(`  > -----------------------------------`);
    log(`  > 合計トークン (Total Tokens): ${step2token[3]}`);



    return { 
      status: "success",
      report: parsedJson,
      source: "live",
      auditLog
    };

  } catch (error) {
    const totalEndTime = process.hrtime.bigint();
    const totalDuration = Number(totalEndTime - totalStartTime) / 1_000_000_000;
    log(`\n[致命的エラー] エージェント実行中に予期せぬエラーが発生しました。 - 合計処理時間: ${totalDuration.toFixed(2)}秒`);
    console.error(error);
    return { status: "error", message: `レポートの生成中にエラーが発生しました。サーバーのログを確認してください。`, auditLog };
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

  //console.log("\n--- 監査ログ ---");
  //console.log(result.auditLog.join('\n'));
}

main().catch(error => {
  console.error("\n[スクリプト致命的エラー] 実行に失敗しました。", error);
  process.exit(1);
});