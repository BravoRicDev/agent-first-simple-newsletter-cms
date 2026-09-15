import config from "../config.js";

async function callLLM(messages, options = {}) {
  if (!config.llmApiKey) throw new Error("LLM_API_KEY (o OPENAI_API_KEY) non configurata");

  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.llmApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model || config.llmModel,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens || 2000,
    }),
    signal: AbortSignal.timeout(options.timeout || 30000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  if (!data.choices?.[0]?.message?.content) {
    throw new Error("LLM API: risposta senza contenuto (choices mancante o vuoto)");
  }
  return data.choices[0].message.content;
}

export async function rewriteText(text, action) {
  const actions = {
    shorter: "più breve e conciso, mantieni i punti chiave",
    longer: "più dettagliato, aggiungi esempi e spiegazioni",
    professional: "più professionale e formale",
    simple: "più semplice e chiaro, adatto a un pubblico ampio",
    friendly: "più amichevole e informale, usa un tono colloquiale",
  };

  const prompt = actions[action] || actions.simple;
  return callLLM([
    { role: "system", content: `Sei un copywriter. Riscrivi il testo seguente per renderlo ${prompt}. Restituisci solo il testo riscritto, senza introduzioni.` },
    { role: "user", content: text },
  ], { temperature: 0.7 });
}

export async function generateAltText(imageBase64, mimeType) {
  return callLLM([
    {
      role: "user",
      content: [
        { type: "text", text: "Descrivi brevemente questa immagine in italiano (max 120 caratteri) per un attributo alt text. Restituisci solo la descrizione." },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: "low" } },
      ],
    },
  ], { maxTokens: 200, temperature: 0.3 });
}

// Completamento libero (chat) — usato dal runtime conversazionale agente
// (feature 29) quando un agent_runtime ha llm_prompt valorizzato. Lancia
// se LLM_API_KEY non è configurata: il chiamante deve fare fallback.
export async function complete(prompt, options = {}) {
  return callLLM([
    { role: "system", content: options.system || "Sei un assistente commerciale. Rispondi in italiano, in modo diretto e conciso, senza prefazioni." },
    { role: "user", content: String(prompt || "") },
  ], { temperature: options.temperature ?? 0.7, maxTokens: options.maxTokens || 500, model: options.model });
}
