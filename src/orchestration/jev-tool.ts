import { JEV_TOOL_SCHEMA } from '../jev/validation';
export const JEV_TOOL = {
  name: 'jev_evaluate',
  description: 'Evaluate bounded text/JSON using configured Jev Choice, Score or Noul questions. Returns typed decisions, probabilities and usage; does not execute actions or grant permissions. This may incur provider usage. Do not submit credentials or unrelated private data. Use the configured model; do not provide a URL or API key.',
  inputSchema: JEV_TOOL_SCHEMA,
};
