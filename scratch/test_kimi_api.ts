import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config({ path: '.env.local' });
dotenv.config();

const kimiKey = process.env.KIMI_API_KEY;
const baseUrl = "https://api.kimi.com/coding/v1";
const model = process.env.KIMI_MODEL || "moonshot-v1-8k";

async function run() {
  console.log(`Kimi API Key: ${kimiKey ? 'SET' : 'MISSING'}`);
  console.log(`Model: ${model}`);
  
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${kimiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Hello, say test" }],
        temperature: 0.3
      })
    });
    
    console.log(`Response Status: ${res.status}`);
    const data = await res.json();
    console.log("Response Data:", JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error("Kimi connection failed:", err.message || err);
  }
}

run();
