import { z } from 'zod';

import { mailsSince } from './mails.js';
import type { BriefSettings } from './settings.js';

// The most shares the brief reads, the newest, as Drive's contract gives them by default
export const MAX_SHARES = 20;

// How far back the brief reads the shares at most: Drive's contract reads 31 days back at most, and
// the day less leaves room for its clock
const LONGEST_BACK_MS = 30 * 86_400_000;

// A file or folder a share gives the owner, as Drive's contract lists it: by the id the other
// operations of Drive take, outside a shared drive, then, under untrusted, the name its sharer gave it
const sharedItemSchema = z.object({
	id: z.string(),
	type: z.enum(['file', 'directory']),
	untrusted: z.object({ name: z.string() })
});

type SharedItem = z.infer<typeof sharedItemSchema>;

// A share another member of Drive gave the owner, as Drive's contract lists it: what Drive computed,
// then, under untrusted, who shared it, as they or the owner's contacts named them
const shareSchema = z.object({
	id: z.string(),
	received_at: z.string(),
	read_only: z.boolean(),
	shared_drive: z.boolean(),
	items: z.array(sharedItemSchema),
	untrusted: z.object({
		shared_by: z.object({ name: z.string().nullable(), email: z.string().nullable() })
	})
});

type Share = z.infer<typeof shareSchema>;

// What Drive lists of the shares the owner received since an instant, the newest first, and whether
// it had more
export const shareListSchema = z.object({ shares: z.array(shareSchema), truncated: z.boolean() });

// A file or folder of a share as the brief tells it: by the number the owner answers it by, but in a
// shared drive, whose files no other operation of Drive reaches
export type ToldItem = SharedItem | ({ readonly number: number } & SharedItem);

export type ToldShare = Omit<Share, 'items'> & { readonly items: readonly ToldItem[] };

// The shares the owner received since the instant the brief reads them from, in the zone of their
// calendar, the newest first, and whether Drive had more
export interface Shares {
	readonly since: string;
	readonly shares: readonly ToldShare[];
	readonly truncated: boolean;
}

// What the number of a file or folder shared with the owner names, for their next turns
export interface ShareReference {
	readonly number: number;
	readonly id: string;
	readonly type: SharedItem['type'];
}

// The instant the brief reads the shares made to the owner from: as their mail, when their last brief
// read them, or before any did, the same time of their wall clock on the last day before today of
// those their brief goes out on, thirty days back at most
export function sharesSince(readAt: Date | null, now: Date, settings: BriefSettings): Date {
	const since = mailsSince(readAt, now, settings);
	return new Date(Math.max(since.getTime(), now.getTime() - LONGEST_BACK_MS));
}

// The shares as the brief tells them, from the instant given: each file and folder numbered after
// the last number the brief gave, in the order Drive listed them, but those of a shared drive
export function sharesOf(
	list: z.infer<typeof shareListSchema>,
	since: string,
	last: number
): Shares {
	let next = last;
	const numbered = (item: SharedItem): ToldItem => {
		next += 1;
		return { number: next, ...item };
	};
	return {
		since,
		shares: list.shares.slice(0, MAX_SHARES).map((share) => ({
			...share,
			items: share.shared_drive ? share.items : share.items.map(numbered)
		})),
		truncated: list.truncated || list.shares.length > MAX_SHARES
	};
}

// The number of a file or folder, when it has one
export function numberOf(item: ToldItem): number | null {
	return 'number' in item ? item.number : null;
}

// What the numbers of the files and folders shared with the owner name: each one by its id
export function shareReferences(shares: Shares): ShareReference[] {
	return shares.shares.flatMap(({ items }) =>
		items.flatMap((item) => {
			const number = numberOf(item);
			return number === null ? [] : [{ number, id: item.id, type: item.type }];
		})
	);
}
