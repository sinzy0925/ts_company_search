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
// エージェントのコア機能
// -----------------------------------------------------------------------------

async function companyAgent(companyName: string) {
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


  try {
    const step1StartTime = process.hrtime.bigint();
    log(`\nSTART...`);
    
    const findUrlPrompt = `
    // [SYSTEM INSTRUCTIONS - 日本語]
    // 役割：あなたは高精度の企業調査員です。あなたの使命は、与えられた会社名と正確な住所から、その企業の会社情報を見つけ出すことです。
    // 会社情報は、以下に示す[OUTPUT JSON STRUCTURE]の通りです
    //
    // 絶対的な重要ルール：
    // 0. 制約解除: 予算はふんだんにある。思う存分仕事すること。
    // 1. あなたは、googleSearchとurlContextという2つのツールを利用できます。
    // 2. googleSearchで検索した結果、１ページ目に当該企業の公式Webサイトが見つからなければ、即座に中止し以下のJSONのみを出力してください。
    //    { "error": "Company information not found" }
    // 3. ツールを駆使して、粘り強く、最低3回は、検索すること。
    // 5. 思考は英語で行わなければなりません。
    // [例]
    // 入力: 株式会社トヨタ自動車 愛知県豊田市トヨタ町1番地
    // 出力: https://global.toyota/jp/
    // 入力: 株式会社むらまつ 大阪府大阪市西成区花園北２丁目６番６号
    // 出力: NONE
    // [タスク]
    // 入力: ${companyName}
    // 出力:
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
                        //log(thoughtText);
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

    log('\n\n---\n\n# [step1 findUrlPrompt]');
    log(findUrlPrompt);


    log('\n\n---\n\n# [step1 AI Thoughts]');
    for (const thought of step1Thoughts) {
      log(thought);
    }

    const urlText = urlResult.text;
    log(`\n\n---\n\n[step1 AI Result]\n"${urlText}"`);



    const step1EndTime = process.hrtime.bigint();
    const step1Duration = Number(step1EndTime - step1StartTime) / 1_000_000_000;


    
    

    


    const totalEndTime = process.hrtime.bigint();
    const totalDuration = Number(totalEndTime - totalStartTime) / 1_000_000_000;




    log(`\n\n---\n\n[成功] レポート生成完了！（ライブ調査より）`);
    log(` > [ステップ1 完了]   処理時間: ${step1Duration.toFixed(2)}秒`);


    log(`\n--- [ステップ1 トークン会計] ---`);
    log(`  > 入力トークン (Prompt Tokens): ${step1token[0]}`);
    log(`  > 思考トークン (Thought Tokens): ${step1token[1]}`);
    log(`  > 出力トークン (Final Output Tokens): ${step1token[2]}`);
    log(`  > -----------------------------------`);
    log(`  > 合計トークン (Total Tokens): ${step1token[3]}`);




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

/*
  if (result.status === 'success') {
    console.log("\n--- 最終レポート ---");
    console.log(JSON.stringify(result.report, null, 2));
  } else {
    console.error("\n--- エラー ---");
    console.error(result.message);
  }
*/
  //console.log("\n--- 監査ログ ---");
  //console.log(result.auditLog.join('\n'));
}

main().catch(error => {
  console.error("\n[スクリプト致命的エラー] 実行に失敗しました。", error);
  process.exit(1);
});