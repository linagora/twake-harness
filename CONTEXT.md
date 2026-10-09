# Twake Space assistants

Each user of a Twake Workplace platform has a personal assistant that acts for them in the Twake applications. This glossary names the people, assistants and conversations involved, and how an assistant arranges a meeting from a conversation it listens to.

## People and assistants

**Owner**:
The person an assistant acts for, known by their email address. An assistant has exactly one owner.
_Avoid_: user (for the assistant's owner), principal (outside code)

**Assistant**:
An owner's personal agent in Twake Chat, which acts in the Twake applications with its owner's rights.
_Avoid_: bot, agent

**Colleague**:
A person of the owner's own organization, on the same mail domain.
_Avoid_: contact, coworker

**Listening journal**:
An owner's record of what their assistant saw and did for them each day, and what came of it, from an invitation received to an availability request answered.
_Avoid_: activity log, history

## Listened conversations

**Listened conversation**:
An encrypted conversation of two people into which one brought their own assistant after the other said yes. The assistant reads it for its owner alone and never writes in it.
_Avoid_: listened room, assistant channel

**Suggestion**:
An action an assistant offers its owner, unasked, from what was said in a conversation its owner takes part in.
_Avoid_: recommendation, hint

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
