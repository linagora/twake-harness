import { BRIEF_DOMAINS } from '../../src/briefs/questions.js';
import type { ConsentLevel } from '../../src/consents/consent.js';
import { grantConsent as grant } from '../../src/consents/repository.js';
import { withPrincipal, type Db } from '../../src/db/client.js';
import { listenUnlessChosen } from '../../src/sources/repository.js';

// Lets an owner's assistant use an application without asking, as the owner's consent would:
// for suites whose subject is not the consent itself
export async function grantConsent(
	db: Db,
	owner: string,
	domain: string,
	level: ConsentLevel
): Promise<void> {
	await withPrincipal(db, { id: owner }, (tx) => grant(tx, owner, domain, level, 'api'));
}

// What an owner's yes to the question of their first brief allows, for suites whose subject is not
// that question: each read of their brief, and their assistant listening to their mail, which their
// brief reads only then
export async function allowBriefReads(db: Db, owner: string): Promise<void> {
	for (const domain of BRIEF_DOMAINS) await grantConsent(db, owner, domain, 'read');
	await withPrincipal(db, { id: owner }, (tx) => listenUnlessChosen(tx, owner, 'mail'));
}

// Takes an application back from an owner's assistant, for a suite that needs a first use again
export async function withdrawConsent(
	db: Db,
	owner: string,
	domain: string,
	level: ConsentLevel
): Promise<void> {
	await withPrincipal(
		db,
		{ id: owner },
		(tx) =>
			tx.sql`delete from consents where owner = ${owner} and domain = ${domain} and level = ${level}`
	);
}
