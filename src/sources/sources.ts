// The applications an owner's assistant may listen to, by the names their consents give them: what
// one of them publishes for the owner wakes the assistant only while it listens there
export const SOURCES = ['calendar', 'tasks', 'mail', 'drive', 'chat'] as const;
export type Source = (typeof SOURCES)[number];

// The sources their owner may have their assistant listen to or not: those whose activities the
// harness takes today, and Mail and Drive, which publish none it takes, so that listening there only
// has their brief read them
export const LISTENABLE: readonly Source[] = ['calendar', 'tasks', 'mail', 'drive'];

// The listenable sources their assistant listens to unless they said otherwise: Mail waits for their
// yes to the question of their first brief, and Drive for their asking
export const LISTENED_BY_DEFAULT: readonly Source[] = ['calendar', 'tasks'];

// The source the calendar producer gave the invitations it published, which the harness gives
// Calendar's notifications and keeps their wake-ups by
export const CALENDAR_SOURCE = 'twake://calendar';

// Each listenable source by the source its producer publishes its activities under, and by none
// other: Calendar's notifications, which the harness names so, and Tasks' events
const PUBLISHED_AS: ReadonlyMap<string, Source> = new Map([
	[CALENDAR_SOURCE, 'calendar'],
	['twake://tasks', 'tasks']
]);

export function isSource(value: string): value is Source {
	return (SOURCES as readonly string[]).includes(value);
}

export function isListenable(value: string): value is Source {
	return (LISTENABLE as readonly string[]).includes(value);
}

// The listenable source an activity was published under, or null for one nobody listens to
export function sourceOfActivity(published: string): Source | null {
	return PUBLISHED_AS.get(published) ?? null;
}

// Whether what a source publishes for its owner wakes their assistant while it listens there
export function wakesAssistant(source: Source): boolean {
	return [...PUBLISHED_AS.values()].includes(source);
}

// What the producers of the sources given publish their activities under
export function publishedUnder(sources: readonly Source[]): string[] {
	return [...PUBLISHED_AS]
		.filter(([, source]) => sources.includes(source))
		.map(([published]) => published);
}
