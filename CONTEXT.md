# Twake Space assistants

Each user of a Twake Workplace platform has a personal assistant that acts for them in the Twake applications. This glossary names the people, assistants and conversations involved, how an assistant hears of what happens for its owner in the Twake applications, and how an assistant arranges a meeting from a conversation it listens to.

## People and assistants

**Owner**:
The person an assistant acts for, known by their email address. An assistant has exactly one owner.
_Avoid_: user (for the assistant's owner), principal (outside code)

**Assistant**:
An owner's personal agent in Twake Chat, which acts in the Twake applications with its owner's rights.
_Avoid_: bot, agent

**Bot**:
A member Twake Chat takes for a bot: an account of our homeserver whose id starts with `@bot_` or `@hermes_`, or a member announcing its commands in the room. It is asked no yes in a listened conversation.
_Avoid_: assistant (an owner's personal agent), agent

**Colleague**:
A person of the owner's own organization, on the same mail domain.
_Avoid_: contact, coworker

**Grounding**:
What an answer of an owner's turn cites must come from what the turn was given: its prompt, the owner's words and the results of its reads. A task key the turn never saw, or a fact of the owner's data the results do not hold, is ungrounded, and the assistant writes the answer again once.
_Avoid_: fact-check, validation

**Listening journal**:
An owner's record of what their assistant saw and did for them each day, and what came of it, from an invitation received to an availability request answered.
_Avoid_: activity log, history

## Listened conversations

**Listened conversation**:
An encrypted conversation, a direct one or a channel, into which one person brought their own assistant after every other person in it said yes. The assistant reads it for its owner alone and never writes in it.
_Avoid_: listened room, assistant channel

**Suggestion**:
An action an assistant offers its owner, unasked, from what was said in a conversation its owner takes part in.
_Avoid_: recommendation, hint

## Hearing of the owner's activity

**Source**:
A Twake application whose activity an assistant hears for its owner only while the owner has it listen there: Calendar, Tasks, Mail, Drive, Chat or Space.
_Avoid_: app, channel, integration

**Activity**:
What a Twake application publishes about one of its objects for the people it names, such as a task assigned to someone or a meeting moved.
_Avoid_: event (the message that carries it), notification

**Wake-up**:
An assistant's message to its owner about an activity that names them and expects something of them, sent without waiting for their brief: a task assigned to them, an invitation, a meeting of theirs moved or cancelled, something shared with them, or a mention, which in Twake Chat waits until they have left it unread for ten minutes.
_Avoid_: notification, alert, ping

**Mention**:
A message, comment or post that names the owner explicitly, as the pill of their name does in Twake Chat, rather than by a word of its text. `@room` mentions no one.
_Avoid_: ping, tag, highlight

**Pending mention**:
A mention of the owner in Twake Chat that the harness keeps, its words included, until it is settled, as their public read receipt on its thread, a message of theirs in its room after it, or the wake-up it gives once they left it unread for ten minutes settles it, and then erases.
_Avoid_: unread mention (what Twake Chat counts), queued notification

**Listener**:
The harness's one account in the clear rooms of Twake Chat, `@twake-assistant`, which reads what is said there for the owners in them and never writes.
_Avoid_: channel bot, listening bot

**Brief**:
The message an assistant sends its owner on the days and at the time they chose, with their day ahead and every activity that waited for it rather than a wake-up.
_Avoid_: digest, daily summary, morning report

**Source offer**:
The question a brief asks its owner once, after it, of having their assistant listen to a source they never chose for.
_Avoid_: proposal (the meeting a suggestion puts to the organizer), suggestion, offer (alone)

**Feed**:
A space's stream in Twake Space: its members' posts and their reactions, and a card for each object of the space's applications, such as a task, a team mail or a folder.
_Avoid_: timeline, wall, message thread

## Arranging a meeting

**Organizer**:
The member of a listened conversation whose assistant makes the proposal and, on their yes, sends the invitation: the author of the message that asked to meet when their own assistant listens, otherwise the other member.
_Avoid_: requester, initiator

**Invitee**:
The other member of a listened conversation, invited to the meeting whether or not they wrote anything.
_Avoid_: participant, guest

**Availability request**:
What the organizer's assistant asks the invitee's assistant: a period, the asked time, a duration and who asks, never anyone's words.
_Avoid_: free/busy query, message between assistants

**Asked time**:
The time a conversation named for the meeting. Unlike the other candidate slots, it may fall outside working hours.
_Avoid_: requested slot, desired time

**Candidate slot**:
A time when the invitee is free, which their assistant offers in answer to an availability request.
_Avoid_: proposal, option

**Availability sharing**:
An owner's standing yes, given once and withdrawable, for their assistant to answer their colleagues' availability requests.
_Avoid_: free/busy sharing, calendar access

**Proposal**:
The one meeting, with its time, title and invitees, that a suggestion puts to the organizer for a yes or a no.
_Avoid_: offer, option

**Personal calendar**:
A calendar its owner owns, as opposed to one shared with them or a resource's.
_Avoid_: agenda
