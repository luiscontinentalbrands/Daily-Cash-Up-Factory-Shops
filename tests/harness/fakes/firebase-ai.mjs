// Stand-in for firebase-ai.js (Gemini). Tests script the replies with globalThis.__fakeAI.reply
// and read back every attempt (route + model) from globalThis.__fakeAI.attempts.
export class VertexAIBackend { constructor(location) { this.route = "vertex:" + location; } }
export class GoogleAIBackend { constructor() { this.route = "google"; } }
export function getAI(app, { backend }) { return { backend }; }
export function getGenerativeModel(ai, { model, generationConfig }) {
  return {
    async generateContent(parts) {
      const ctl = globalThis.__fakeAI, attempt = { route: ai.backend.route, model, generationConfig };
      ctl.attempts.push(attempt);
      ctl.prompts.push(parts[0]);
      const text = await ctl.reply(attempt, parts);
      return { response: { text: () => text } };
    },
  };
}
