import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * Web search via the Exa API (https://exa.ai), called with raw `fetch` to keep
 * the dependency surface minimal (no `exa-js` SDK).
 *
 * Graceful fallback: if `EXA_API_KEY` is missing or the call throws / returns a
 * non-200, this returns `{ results: [] }` instead of throwing, so the draftEmail
 * step can still proceed from the prospect input + model knowledge. The demo
 * never hard-fails on a missing or flaky key.
 */

const EXA_ENDPOINT = 'https://api.exa.ai/search';

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  summary: z.string(),
  highlights: z.array(z.string()),
  publishedDate: z.string(),
  author: z.string(),
});

/** A single mapped search result, as exposed by the tool and `exaSearch`. */
export type WebSearchResult = z.infer<typeof resultSchema>;

/** Shape of a single result in Exa's `/search` response (fields we use). */
interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
  summary?: string;
  highlights?: string[];
  publishedDate?: string;
  author?: string;
}
interface ExaSearchResponse {
  results?: ExaResult[];
}

export const webSearchTool = createTool({
  id: 'web-search',
  description:
    'Search the web for up-to-date information about a person or company using the Exa API. ' +
    'Accepts a free-text query or a LinkedIn URL. Returns titles, URLs, AI summaries, and ' +
    'highlight snippets. Returns an empty result set (rather than failing) if search is unavailable.',
  inputSchema: z.object({
    query: z.string().describe('Search query — a name, topic, or a LinkedIn/company URL'),
    category: z
      .string()
      .optional()
      .describe("Exa category to focus the search, e.g. 'people' or 'company'"),
    numResults: z.number().optional().describe('Max number of results (default 5)'),
  }),
  outputSchema: z.object({
    results: z.array(resultSchema),
  }),
  execute: async inputData => {
    return await exaSearch(inputData.query, inputData.category, inputData.numResults);
  },
});

/**
 * Core Exa search, shared by the tool (for agent use) and the research workflow
 * step (for a direct call without a tool-execution context). Always resolves —
 * returns `{ results: [] }` on missing key / non-200 / network error.
 */
export async function exaSearch(
  query: string,
  category?: string,
  numResults?: number,
): Promise<{ results: WebSearchResult[] }> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    // No key configured — fall back silently so draftEmail can still run.
    return { results: [] };
  }

  try {
    const res = await fetch(EXA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query,
        type: 'auto', // 'auto' default; 'fast' for low-latency; 'deep' for richer research
        category: category ?? 'people', // 'people' fits prospect research; 'company' for the org pass
        numResults: numResults ?? 5,
        contents: { highlights: true, summary: true }, // token-efficient extracts + AI summary
      }),
    });

    if (!res.ok) {
      return { results: [] };
    }

    const data = (await res.json()) as ExaSearchResponse;
    const results = (data.results ?? []).map(r => ({
      title: r.title ?? '',
      url: r.url ?? '',
      // Prefer Exa's AI summary; fall back to raw extracted text.
      summary: r.summary ?? r.text ?? '',
      highlights: r.highlights ?? [],
      publishedDate: r.publishedDate ?? '',
      author: r.author ?? '',
    }));
    return { results };
  } catch {
    // Network error / bad JSON / timeout — degrade gracefully, never throw.
    return { results: [] };
  }
}
