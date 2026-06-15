import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { exaSearch, type WebSearchResult } from '../tools/web-search-tool';

/**
 * prospect-workflow: research a prospect, then draft a personalized Keplar
 * outreach email — but ONLY for a prospect whose identity we can verify.
 *
 * Identity policy (deliberate, see CLAUDE.md / project memory):
 *   - Research queries Exa with the LinkedIn URL ONLY (no name/company pass).
 *   - We use the research only if a returned result's URL is a PERFECT match to
 *     the provided URL. On no match (or no URL), we DO NOT draft — to avoid
 *     emailing the wrong person — and return status 'unverified' instead.
 */

const prospectSchema = z.object({
  // The LinkedIn URL is the identity authority. The prospect's name is derived
  // from the matched profile (Exa), not supplied by the caller.
  linkedinUrl: z.string().optional(),
  role: z.string().optional(),
  company: z.string().optional(),
  notes: z.string().optional(),
});

const emailSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

// Intermediate output of the research step.
const researchSchema = z.object({
  prospect: prospectSchema,
  verified: z.boolean(),
  prospectName: z.string(), // name from the matched LinkedIn profile ('' if none)
  researchSummary: z.string(), // populated when verified
  matchedUrl: z.string(), // the exact profile URL we matched ('' if none)
  reason: z.string(), // why we couldn't verify ('' when verified)
});

// Final workflow output: a drafted email OR an identity-unverified notice.
const outputSchema = z.object({
  status: z.enum(['drafted', 'unverified']),
  subject: z.string(),
  body: z.string(),
  researchSummary: z.string(),
  reason: z.string(),
});

/**
 * Cosmetic URL normalization for identity comparison: lowercase, drop the
 * scheme, a leading `www.`, any query/hash, and a trailing slash. The remaining
 * host+path must be identical to count as the same profile.
 */
function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

/** Build a readable research summary string from a matched Exa result. */
function summarizeResult(r: WebSearchResult): string {
  const parts: string[] = [];
  if (r.title) parts.push(`Profile: ${r.title}`);
  if (r.summary) parts.push(r.summary.trim());
  const highlights = (r.highlights ?? []).filter(Boolean).slice(0, 3);
  if (highlights.length) {
    parts.push('Highlights:\n' + highlights.map(h => `- ${h.replace(/\s+/g, ' ').trim()}`).join('\n'));
  }
  return parts.join('\n\n');
}

const researchProspect = createStep({
  id: 'research-prospect',
  description: 'Verify the prospect via their LinkedIn URL (exact match) and summarize findings',
  inputSchema: z.object({
    prospect: prospectSchema,
    rawQuery: z.string(),
  }),
  outputSchema: researchSchema,
  execute: async ({ inputData }) => {
    const { prospect } = inputData;
    const url = prospect.linkedinUrl?.trim();

    // No URL → cannot verify identity → do not draft.
    if (!url) {
      return {
        prospect,
        verified: false,
        prospectName: '',
        researchSummary: '',
        matchedUrl: '',
        reason:
          'No LinkedIn URL was provided, so I could not verify this person’s identity. ' +
          'To avoid emailing the wrong person, I did not draft an email.',
      };
    }

    // Single pass: query Exa with the LinkedIn URL only.
    const { results } = await exaSearch(url, 'people', 5);
    const target = normalizeUrl(url);
    const match = results.find(r => r.url && normalizeUrl(r.url) === target);

    if (!match) {
      return {
        prospect,
        verified: false,
        prospectName: '',
        researchSummary: '',
        matchedUrl: '',
        reason:
          'I could not find a profile that exactly matches the provided LinkedIn URL ' +
          `(${url}). To avoid emailing the wrong person, I did not draft an email.`,
      };
    }

    return {
      prospect,
      verified: true,
      // Name comes from the matched profile, not the caller.
      prospectName: (match.title ?? '').trim(),
      researchSummary: summarizeResult(match),
      matchedUrl: match.url,
      reason: '',
    };
  },
});

const draftEmail = createStep({
  id: 'draft-email',
  description: 'Draft a personalized Keplar outreach email, only for a verified prospect',
  inputSchema: researchSchema,
  outputSchema,
  execute: async ({ inputData, mastra }) => {
    // Identity not verified → pass the notice straight through; never draft.
    if (!inputData.verified) {
      return {
        status: 'unverified' as const,
        subject: '',
        body: '',
        researchSummary: '',
        reason: inputData.reason,
      };
    }

    const agent = mastra?.getAgent('outreachAgent');
    if (!agent) {
      throw new Error('Outreach agent not found');
    }

    const { prospectName, researchSummary } = inputData;
    const prompt = `Draft a personalized Keplar outreach email for this prospect.

PROSPECT NAME (verified from their LinkedIn profile — greet them by this name):
${prospectName || '(name unavailable)'}

VERIFIED RESEARCH (use only these facts to personalize — do not invent others):
${researchSummary}

Write the subject and body following your instructions.`;

    const result = await agent.generate(prompt, {
      structuredOutput: { schema: emailSchema },
    });
    const email = result.object ?? { subject: '', body: '' };

    return {
      status: 'drafted' as const,
      subject: email.subject,
      body: email.body,
      researchSummary,
      reason: '',
    };
  },
});

const prospectWorkflow = createWorkflow({
  id: 'prospect-workflow',
  inputSchema: z.object({
    prospect: prospectSchema,
    rawQuery: z.string(),
  }),
  outputSchema,
})
  .then(researchProspect)
  .then(draftEmail);

prospectWorkflow.commit();

export { prospectWorkflow, prospectSchema, emailSchema };
