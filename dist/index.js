"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const genai_1 = require("@google/genai");
const dotenv_1 = __importDefault(require("dotenv"));
const axios_1 = __importDefault(require("axios"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// -----------------------------------------------------------------------------
// 0. 初期設定と型定義
// -----------------------------------------------------------------------------
dotenv_1.default.config();
const KNOWLEDGE_BASE_PATH = path.join(__dirname, 'knowledge-base.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    throw new Error("環境変数 GEMINI_API_KEY が設定されていません。");
}
// 新SDKの作法でクライアントを初期化
const ai = new genai_1.GoogleGenAI({ apiKey: GEMINI_API_KEY });
// -----------------------------------------------------------------------------
// 1. 知識ベース（記憶）の操作関数
// -----------------------------------------------------------------------------
function loadKnowledgeBase(log) {
    try {
        if (fs.existsSync(KNOWLEDGE_BASE_PATH)) {
            const fileContent = fs.readFileSync(KNOWLEDGE_BASE_PATH, 'utf-8');
            if (fileContent) {
                return JSON.parse(fileContent);
            }
        }
        log("  > [記憶] 知識ベースファイルが存在しないか空のため、新しい記憶を開始します。");
        return {};
    }
    catch (error) {
        log(`  > [記憶エラー] 知識ベースの読み込みに失敗しました: ${error}`);
        return {};
    }
}
function saveKnowledgeBase(knowledgeBase, log) {
    try {
        fs.writeFileSync(KNOWLEDGE_BASE_PATH, JSON.stringify(knowledgeBase, null, 2));
        log("  > [記憶] 新しい知識を知識ベースに保存しました。");
    }
    catch (error) {
        log(`  > [記憶エラー] 知識ベースの保存に失敗しました: ${error}`);
    }
}
// -----------------------------------------------------------------------------
// 2. エージェントのコア機能
// -----------------------------------------------------------------------------
async function companyAgent(companyName) {
    const auditLog = [];
    const log = (message) => {
        console.log(message);
        auditLog.push(message);
    };
    const step1token = [];
    const step2token = [];
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
        const totalDuration = Number(totalEndTime - totalStartTime) / 1000000000;
        log(`\n[成功] レポート生成完了！（キャッシュより） - 合計処理時間: ${totalDuration.toFixed(2)}秒`);
        return {
            status: "success",
            report: knowledgeBase[normalizedCompanyName].report,
            source: "cache",
            auditLog
        };
    }
    log(`  > [記憶] 過去の調査記録はありません。ライブ調査に移行します。`);
    try {
        const step1StartTime = process.hrtime.bigint();
        log(`\n[フェーズ2, ステップ1] 公式サイトURL特定プロセス開始...`);
        const findUrlPrompt = `
    // [SYSTEM INSTRUCTIONS - ENGLISH]
    // === CORE MISSION & PHILOSOPHY ===
    // Your primary and most important job is to find a URL that EXACTLY matches the company name AND address provided by the user.
    // Providing a URL with a different company name or address will confuse the user, so this must be avoided at all costs.
    // If you cannot find a URL that perfectly matches the user's input, you MUST immediately return "NONE".
    //
    // ROLE: You are a high-precision corporate investigator. Your mission is to find the official website URL for a given company name AND its exact address.
    //
    // ABSOLUTE CRITICAL RULES:
    // 1.  You have two tools at your disposal: googleSearch and urlContext.
    // 2.  Your first step is to use googleSearch to find potential website URLs. Your search queries must be in Japanese and include the address and the company name with keywords like "会社概要".
    // 3.  If googleSearch provides a potential URL (even a redirect URL), your second step is to use the urlContext tool on that URL to verify its content.
    // 4.  Your ONLY GOAL is to confirm, using urlContext, that the website's content contains an address that is an EXACT or a VERY CLOSE STRING MATCH to the input address.
    // 5.  You are only authorized to output a URL if the company name AND address found on the website are an EXACT or VERY CLOSE match to the user's input:${companyName}. "VERY CLOSE" only applies to minor formatting differences. A different company name or a different city is a FAILED verification.
    // 6.  **Special Protocol for Mismatched Information:** If you encounter a situation where the **address matches** but the **company name is slightly different** (e.g., a trade name or "doing business as" name), you are authorized to perform **one final, additional googleSearch**. This secondary search should use new keywords found on the website (like the trade name) to find objective, third-party evidence (e.g., news articles, business directories) that confirms the two companies are the same entity. Only if you find such conclusive evidence are you authorized to judge the site as a "MATCH". 
    // 7.  If you can confirm a matching address via urlContext, you MUST output the confirmed URL.
    // 8.  If you cannot find any potential websites, or if urlContext fails to confirm a matching address, you MUST return the single, uppercase word "NONE".
    // 9.  Your final output MUST be ONLY the URL itself or the word "NONE".
    // 10.  You MUST think in English.

      // [EXAMPLES]
      // Input: 株式会社トヨタ自動車 愛知県豊田市トヨタ町1番地
      // Output: https://global.toyota/jp/
      
      // Input: 株式会社むらまつ 大阪府大阪市西成区花園北２丁目６番６号
      // Output: NONE
      
      // [TASK]
      // Input: ${companyName}
      // Output:
    `;
        log("# [step1 findUrlPrompt]");
        log(findUrlPrompt);
        const urlResult = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts: [{ text: findUrlPrompt }] }],
            config: {
                tools: [{ googleSearch: {} }, { urlContext: {} }],
                temperature: 0.0,
                thinkingConfig: {
                    includeThoughts: true,
                    thinkingBudget: -1
                }
            },
        });
        const step1Thoughts = [];
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
                                const thoughtTokens = await ai.models.countTokens({
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
            step1token.push(thoughtTokenCount ?? 0);
            step1token.push(outputTokenCount ?? 0);
            step1token.push(totalTokenCount ?? 0);
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
        const step1Duration = Number(step1EndTime - step1StartTime) / 1000000000;
        const step1_5_StartTime = process.hrtime.bigint();
        log(`\n[フェーズ2, ステップ1.5] リダイレクト解決プロセス開始...`);
        let finalUrl = initialUrl;
        if (initialUrl.includes("vertexaisearch.cloud.google.com")) {
            try {
                const response = await axios_1.default.get(initialUrl, { maxRedirects: 5 });
                finalUrl = response.request.res.responseUrl || initialUrl;
                log(`  > [プログラムの成果] リダイレクトを解決しました。`);
            }
            catch (redirectError) {
                log(`  > [プログラムの失敗] リダイレクトの解決に失敗しました。`);
                finalUrl = initialUrl;
            }
        }
        log(`  > [確定情報] 最終的な公式サイトURL: ${finalUrl}`);
        const step1_5_EndTime = process.hrtime.bigint();
        const step1_5_Duration = Number(step1_5_EndTime - step1_5_StartTime) / 1000000000;
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
                tools: [{ googleSearch: {} }, { urlContext: {} }],
                temperature: 0.0,
                thinkingConfig: {
                    includeThoughts: true,
                    thinkingBudget: -1
                },
                safetySettings: [
                    { category: genai_1.HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: genai_1.HarmBlockThreshold.BLOCK_ONLY_HIGH },
                    { category: genai_1.HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: genai_1.HarmBlockThreshold.BLOCK_ONLY_HIGH },
                ]
            }
        });
        const step2Thoughts = [];
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
                                const thoughtTokens = await ai.models.countTokens({
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
            step2token.push(thoughtTokenCount ?? 0);
            step2token.push(outputTokenCount ?? 0);
            step2token.push(totalTokenCount ?? 0);
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
        }
        catch (e) {
            log(`  > [プログラムの失敗] 抽出されたJSON文字列のパースに失敗しました。`);
            throw new Error("Failed to parse the extracted JSON string.");
        }
        if (parsedJson.error) {
            log(`  > [AIの能力限界] モデルは意図的にエラーを報告しました: ${parsedJson.error}`);
            return { status: "error", message: `レポートを生成できませんでした。モデルからの報告: ${parsedJson.error}`, auditLog };
        }
        const step2EndTime = process.hrtime.bigint();
        const step2Duration = Number(step2EndTime - step2StartTime) / 1000000000;
        log(`\n[フェーズ3] 記憶の形成プロセス開始...`);
        const newKnowledgeEntry = {
            companyName: normalizedCompanyName,
            officialUrl: finalUrl,
            step1Thoughts: step1Thoughts,
            report: parsedJson,
            lastUpdated: new Date().toISOString()
        };
        knowledgeBase[normalizedCompanyName] = newKnowledgeEntry;
        saveKnowledgeBase(knowledgeBase, log);
        const totalEndTime = process.hrtime.bigint();
        const totalDuration = Number(totalEndTime - totalStartTime) / 1000000000;
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
    }
    catch (error) {
        const totalEndTime = process.hrtime.bigint();
        const totalDuration = Number(totalEndTime - totalStartTime) / 1000000000;
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
    }
    else {
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
