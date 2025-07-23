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
                        // log(thoughtText);
                        step1Thoughts.push(part.text);
                    }
                }
            }
        }
    }
    
    log(`\n--- [ステップ1 トークン会計] ---`);
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
        
        log(`  > 入力トークン (Prompt Tokens): ${promptTokenCount}`);
        log(`  > 思考トークン (Thought Tokens): ${thoughtTokenCount}`);
        log(`  > 出力トークン (Final Output Tokens): ${outputTokenCount}`);
        log(`  > -----------------------------------`);
        log(`  > 合計トークン (Total Tokens): ${totalTokenCount}`);
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
      // ROLE: You are a senior business analyst tasked with completing a final intelligence report. You will inherit the research findings from a junior agent.
      // CONSTRAINTS:
      // 1. You MUST carefully review the "JUNIOR AGENT'S THOUGHT LOG" below to fully understand the investigation's context. This log explains how the TARGET URL was identified.
      // 2. Based on this context, your primary mission is to conduct a thorough investigation of the entire website at the "TARGET URL". You should prioritize finding pages with Japanese names like "会社概要", "企業情報", or "About Us".
      // 3. You are authorized to use the googleSearch tool to supplement your findings if the TARGET URL lacks information, but the TARGET URL is your primary source.
      // 4. Your final output MUST be ONLY a JSON object that strictly adheres to the "OUTPUT JSON STRUCTURE". Do not include any introductory text, concluding remarks, or markdown like \`\`\`json.
      // 5. Think in English. Formulate your research plan and analyze findings in English. However, your final JSON values MUST be in Japanese as you are reporting for a Japanese client.

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

    /*
      【日本語訳】
      // [システム指示 - 英語]
      // 役割： あなたは、ジュニアエージェントの調査結果を引き継いで、最終的な情報レポートを完成させる責任を持つ、シニアビジネスアナリストです。
      // 制約：
      // 1. あなたは必ず、以下の「ジュニアエージェントの思考ログ」を注意深く読み、調査の文脈を完全に理解しなければなりません。このログは、ターゲットURLがどのように特定されたかを説明しています。
      // 2. この文脈に基づき、あなたの主要な任務は、「ターゲットURL」にあるウェブサイト全体を徹底的に調査することです。「会社概要」「企業情報」「About Us」のような日本語のページを優先的に探しなさい。
      // 3. もしターゲットURLの情報が不足している場合、調査結果を補うためにgoogleSearchツールを使用することを許可します。しかし、ターゲットURLがあなたの一番の情報源です。
      // 4. あなたの最終的な出力は、「出力JSON構造」に厳密に従った、JSONオブジェクト「のみ」でなければなりません。導入文、結論、\`\`\`jsonのようなマークダウンを一切含めてはいけません。
      // 5. 思考は英語で行いなさい。調査計画の策定や発見事項の分析は英語で行ってください。しかし、あなたは日本の顧客のために報告するので、最終的なJSONの「値」は、必ず日本語でなければなりません。
    */

    log('extractInfoPrompt');
    log(extractInfoPrompt);

    const jsonResult = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: extractInfoPrompt }] }],
      config: {
        tools: [{ googleSearch: {} }],//, {urlContext: {}}],
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

    if (jsonResult.candidates && jsonResult.candidates.length > 0) {
      for (const candidate of jsonResult.candidates) {
          if (candidate.content && candidate.content.parts) {
              for (const part of candidate.content.parts) {
                  if (part.thought && typeof part.text === 'string') {
                      const thoughtText = `  > [AIの思考ログ - ステップ2] \n---\n${part.text}\n---`;
                      //log(thoughtText);
                  }
              }
          }
      }
    }

    log(`\n--- [ステップ2 トークン会計] ---`);
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

        log(`  > 入力トークン (Prompt Tokens): ${promptTokenCount}`);
        log(`  > 思考トークン (Thought Tokens): ${thoughtTokenCount}`);
        log(`  > 出力トークン (Final Output Tokens): ${outputTokenCount}`);
        log(`  > -----------------------------------`);
        log(`  > 合計トークン (Total Tokens): ${totalTokenCount}`);
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
    const newKnowledgeEntry: KnowledgeBaseEntry = {
        companyName: normalizedCompanyName,
        officialUrl: finalUrl,
        step1Thoughts: step1Thoughts,
        report: parsedJson,
        lastUpdated: new Date().toISOString()
    };
    knowledgeBase[normalizedCompanyName] = newKnowledgeEntry;
    saveKnowledgeBase(knowledgeBase, log);

    log(`\n[成功] レポート生成完了！（ライブ調査より）`);
    return { 
      status: "success",
      report: parsedJson,
      source: "live",
      auditLog
    };

  } catch (error) {
    log(`\n[致命的エラー] エージェント実行中に予期せぬエラーが発生しました。`);
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

  console.log("\n--- 監査ログ ---");
  console.log(result.auditLog.join('\n'));
}

main().catch(error => {
  console.error("\n[スクリプト致命的エラー] 実行に失敗しました。", error);
  process.exit(1);
});