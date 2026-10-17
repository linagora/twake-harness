import type { Capability } from '../../src/agent/route.js';

// What an assistant can do in its owner's calendar and mail, as a catalog names it
export const ROUTING_CAPABILITIES: readonly Capability[] = [
	{
		name: 'read_freebusy',
		description: 'Tell whether the user is free over a period',
		acts: false
	},
	{
		name: 'list_events',
		description: 'List the events and invitations the user received',
		acts: false
	},
	{ name: 'search_emails', description: "Searches the user's mail", acts: false },
	{ name: 'create_event', description: "Create a meeting in the user's calendar", acts: true },
	{ name: 'accept_invitation', description: 'Accept an invitation', acts: true },
	{ name: 'send_email', description: 'Sends a mail in the name of the user', acts: true }
];

// A message an owner may write, and the capabilities it asks for. Written for this suite, in the
// two languages the assistants speak: no message of a real owner is among them.
export type RoutingCase = readonly [message: string, asks: readonly string[]];

const CREATE: readonly RoutingCase[] = [
	['Crée une réunion avec Paul demain à 10h', ['create_event']],
	['Ajoute un rendez-vous dentiste vendredi 9h dans mon agenda', ['create_event']],
	['Bloque-moi jeudi après-midi pour la revue budget', ['create_event']],
	["Planifie un point d'équipe lundi à 14h", ['create_event']],
	['Mets un déjeuner avec Marie mardi midi dans mon calendrier', ['create_event']],
	['Tu peux me caler une réunion de 30 minutes avec Khaled demain à 9h ?', ['create_event']],
	['Schedule a call with the design team on Thursday at 3pm', ['create_event']],
	['Add a meeting named Roadmap to my calendar next Monday 9:00', ['create_event']],
	['Book one hour tomorrow at 11 for the budget review', ['create_event']],
	['Create an event for the team lunch on Friday noon', ['create_event']],
	['Please put the quarterly review in my calendar on the 20th at 10:00', ['create_event']],
	[
		'Mets un rendez-vous avec Paul demain de 14h à 15h si je suis libre',
		['read_freebusy', 'create_event']
	],
	["If I'm free on Friday at 4pm, schedule a sync with Anna", ['read_freebusy', 'create_event']],
	[
		'Vérifie que je suis dispo mercredi 10h et crée la réunion client si oui',
		['read_freebusy', 'create_event']
	],
	[
		'Check my availability Tuesday at 9 and book the workshop then if it is open',
		['read_freebusy', 'create_event']
	]
];

const FREEBUSY: readonly RoutingCase[] = [
	['Suis-je libre demain à 14h ?', ['read_freebusy']],
	["Est-ce que j'ai un créneau jeudi matin ?", ['read_freebusy']],
	['Je suis dispo vendredi après-midi ?', ['read_freebusy']],
	['Quand suis-je disponible cette semaine ?', ['read_freebusy']],
	['Ai-je du temps libre mardi entre 10h et 12h ?', ['read_freebusy']],
	['Tu peux regarder si je suis occupé lundi à 9h ?', ['read_freebusy']],
	['Am I free tomorrow at 3pm?', ['read_freebusy']],
	['Is my Thursday afternoon open?', ['read_freebusy']],
	["Can you check whether I'm available on the 14th at noon?", ['read_freebusy']],
	['Do I have a free hour on Wednesday morning?', ['read_freebusy']]
];

const EVENTS: readonly RoutingCase[] = [
	['Quelles invitations ai-je reçues ?', ['list_events']],
	['Montre-moi mes dernières invitations', ['list_events']],
	['Y a-t-il de nouveaux événements pour moi ?', ['list_events']],
	["Qu'est-ce que j'ai reçu comme invitations aujourd'hui ?", ['list_events']],
	['What invitations did I get this week?', ['list_events']],
	['List the events I received', ['list_events']],
	['Any new invitations?', ['list_events']],
	['Show me my pending invitations', ['list_events']]
];

const ACCEPT: readonly RoutingCase[] = [
	["Accepte l'invitation de Bob", ['accept_invitation']],
	['Dis oui à la réunion de Marie', ['accept_invitation']],
	['Confirme ma présence à la réunion de jeudi', ['accept_invitation']],
	["J'accepte l'invitation de Paul, valide-la", ['accept_invitation']],
	['Accept the invitation to the budget review', ['accept_invitation']],
	["Please accept Anna's meeting invite", ['accept_invitation']],
	["Accepte l'invitation de Bob si je suis libre", ['read_freebusy', 'accept_invitation']],
	[
		'Accept the workshop invitation if I have no conflict at that time',
		['read_freebusy', 'accept_invitation']
	]
];

const SEND: readonly RoutingCase[] = [
	['Envoie le budget à Paul par mail', ['send_email']],
	['Écris un mail à Marie pour lui dire que je serai en retard, et envoie-le', ['send_email']],
	["Réponds à Khaled par mail que c'est d'accord", ['send_email']],
	['Envoie un courriel à compta@exemple.fr pour demander la facture', ['send_email']],
	['Préviens Théo par mail que je suis absent demain', ['send_email']],
	['Send an email to Anna saying the report is ready', ['send_email']],
	['Email the team that the meeting is cancelled', ['send_email']],
	['Drop a mail to Bob: lunch at noon?', ['send_email']],
	["Mail my manager that I'll work from home tomorrow", ['send_email']]
];

const SEARCH: readonly RoutingCase[] = [
	['Retrouve le mail de Marie sur le budget', ['search_emails']],
	["Cherche dans mes mails la facture d'octobre", ['search_emails']],
	['Ai-je reçu un mail de Paul cette semaine ?', ['search_emails']],
	["Montre-moi les mails de Khaled d'hier", ['search_emails']],
	['Find the email from Anna about the contract', ['search_emails']],
	['Search my inbox for messages from the bank', ['search_emails']],
	['Did Bob email me about the offsite?', ['search_emails']],
	['Look up the last email I got from HR', ['search_emails']],
	[
		'Retrouve le mail de Marie sur le budget et transfère-le à Paul',
		['search_emails', 'send_email']
	],
	["Find Anna's last email and reply to her that I agree", ['search_emails', 'send_email']]
];

// Messages that ask for none of them: small talk, knowledge, questions about what the assistant
// can do, things said of a meeting or a mail without asking for anything, and requests not to act
const NOTHING: readonly RoutingCase[] = [
	['Bonjour', []],
	['Merci beaucoup', []],
	['Salut, ça va ?', []],
	['Bonne journée', []],
	['Parfait, merci', []],
	['Hello!', []],
	["Thanks, that's all", []],
	['Good morning', []],
	['ok', []],
	['Quelle est la capitale de la France ?', []],
	['Combien font 12 fois 12 ?', []],
	["Traduis 'bonjour' en espagnol", []],
	['Raconte-moi une blague', []],
	["Qu'est-ce que le RGPD ?", []],
	['What is the capital of Japan?', []],
	['Explain what an API is', []],
	['Write a haiku about autumn', []],
	['Que peux-tu faire pour moi ?', []],
	['Peux-tu gérer mon agenda, en général ?', []],
	['Comment fonctionne ton accès à mes mails ?', []],
	['What can you do?', []],
	['Are you able to send emails?', []],
	["J'ai un rendez-vous chez le dentiste demain, ça m'angoisse", []],
	["La réunion d'hier était interminable", []],
	["Marie m'a envoyé un mail très sympa hier", []],
	['Paul a annulé notre déjeuner, tant pis', []],
	['My meeting with Paul went really well', []],
	['I hate writing emails', []],
	['I got invited to three parties this weekend, lucky me', []],
	['Ne crée surtout pas de réunion demain', []],
	["N'accepte pas l'invitation de Bob pour l'instant", []],
	["Don't send that email yet", []],
	['No need to check my calendar', []],
	['Comment rédiger un bon mail de relance ?', []],
	['Donne-moi des conseils pour organiser une réunion efficace', []],
	["Rédige un brouillon de mail pour Paul, je l'enverrai moi-même", []],
	["What's a good time of day for meetings in general?", []],
	["Should I accept invitations from people I don't know?", []],
	['Write me a draft invitation text for the team party, I will post it myself', []],
	['Souviens-toi que je préfère les réunions le matin', []],
	['Parle-moi en anglais', []],
	['Remember that my manager is Anna', []]
];

export const ROUTING_CASES: readonly RoutingCase[] = [
	...CREATE,
	...FREEBUSY,
	...EVENTS,
	...ACCEPT,
	...SEND,
	...SEARCH,
	...NOTHING
];
