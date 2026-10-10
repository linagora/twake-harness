import { z } from 'zod';

// A message of a channel as the model is handed it. The queue holds it until the model has
// answered, then deletes the job; nothing else keeps it.
export const quotedSchema = z.object({
	// The Matrix identifier and the platform email of the author, which the harness computes
	author: z.string().min(1),
	email: z.string().min(1),
	text: z.string().max(600)
});
export type Quoted = z.infer<typeof quotedSchema>;

// A second try at another time: what the call refused said, which no message is needed for
export const retrySchema = z.object({
	title: z.string().max(200),
	attendees: z.array(z.string().max(320)).max(20),
	start: z.string().max(64),
	end: z.string().max(64),
	timeZone: z.string().max(64).nullable()
});
export type Retry = z.infer<typeof retrySchema>;

export const suggestPayloadSchema = z.object({
	owner: z.string().min(1),
	// The channel
	roomId: z.string().min(1),
	eventId: z.string().min(1),
	// When the job was queued, in ms: a job older than a few minutes is dropped, content included
	at: z.number(),
	quoted: z.array(quotedSchema).max(2),
	retry: retrySchema.optional(),
	// An encrypted direct conversation whose owner invited their assistant: there it proposes from
	// the owner's calendar alone, never reading the invitee's, and says so
	listened: z.boolean().optional()
});
export type SuggestPayload = z.infer<typeof suggestPayloadSchema>;

// A suggestion is stale after this long
export const SUGGEST_MAX_AGE_MS = 10 * 60 * 1000;

// How often a suggestion that waits for its owner to let their assistant read what it needs looks
// for their answer, until it is stale
export const SUGGEST_RECHECK_MS = 5_000;

// The group of an owner's suggestions, apart from their turns
export function suggestGroup(owner: string): string {
	return `suggest:${owner}`;
}
