# A turn holds its answer to the data it was given

`verify` checks an answer for one thing: that it does not say the assistant did something it did not. Nothing checks what the answer says of the owner's data. In a real turn, the assistant misdated a comment: it gave what a first comment said with the date of a later one of the same task, mixing two facts of the data it had just read, and the owner read it as true.

## Decision

A step `ground` of the turn's graph, behind the switch `TURN_GROUNDING` (`off` by default, `measure`, `on`), sits after the answer of the lane and before `verify`, so that `verify` judges the words the owner will read; also after `wrapUp` when its words answer a call written as text. It never runs for an account at a limit, a turn others started (events, suggestions), a question of the harness or a silent turn.

- A fixed rule: a task key (`[A-Z][A-Z0-9]*-\d+`) of the answer must appear in what the turn was given, whole: the full system prompt, the owner's messages (briefs and their references among them) and the results of the calls, of this turn and of earlier ones, not the window of eight messages and 1,500 characters `verify` reads. The assistant's own earlier answers and calls are no data. Only a key whose prefix (the letters before the dash) is one of a key of that data is held: `WEB-13` is flagged when the data holds `WEB-12`.
- A model check, when the turn has at least one result: `LLM_CHECK_MODEL` reads the answer sentence by sentence against the results, the owner's message and the data of earlier turns (30,000 characters in all, newest first, a message cut only when it alone exceeds what remains; this turn's results stay whole), told the present and the owner's time zone, and that times in the results may be UTC or carry an offset, and names those that state a fact about the owner's data they do not support (a wrong date, person or number, an absent item, two facts mixed). It runs even when the key rule already failed. A check that fails or is unreadable changes nothing.
- An answer that fails either check is written again once, by the model with no tools, told in its system prompt which keys and sentences are unsupported and to answer from the data alone; its first words are never kept in the conversation. The new words are checked again; if they still fail, the owner reads them with a note of the harness below ("Some details of this answer could not be found in your data: check them before relying on them."). A rewrite that fails keeps the first words. In `measure`, the checks run and are logged, nothing is written again and no note is added: this is the first mode to turn on, to count the hits and the false positives on real turns.
- Logs hold counts and durations, never text. The tokens of the checks and of the rewrite count against the turn like `verify`'s.

## Considered Options

- **A note only**, under the answer, with no rewrite. Rejected: the owner still reads the wrong fact first, and the model can often correct it from the data it holds.
- **A log only**. Rejected as the end state: it measures the problem and protects nobody. It is the `measure` mode, the first to turn on, to count false positives before `on`.
- **Fixed rules for dates and numbers**, as for keys. Rejected: the calendar returns UTC and the model shows local time, so a correct answer would be refused; dates and numbers would be mostly false positives. Only keys, which are written the same everywhere, are held by a rule.

## Consequences

- Every turn that read something costs one more call of the check model. A hit costs a check, a rewrite and a second check, each resending the results of the turn, all counted in the owner's daily tokens.
- Without `LLM_CHECK_MODEL`, the assistant's model checks itself (the dev deployment sets none); `verify` does not run without `LLM_DECISION_MODEL`, while `ground` does.
- The prefix rule avoids the false positives of `J-1`, `UTC-5` or `ISO-9001`, which look like keys and name no task; telling the check model the zone and that results may be UTC avoids those of times shown in local time. A prefix the data shares with such a word, say an `ISO-8601` in a result, still flags the others: to measure.
- The model check does not read the system prompt, which holds the owner's memory: a sentence drawn from that memory alone may be found unsupported and written again. To measure, or to give the check that memory, before the switch is turned on.
- Off by default; `measure` first, until false positives are counted on real turns, and `on` only after.
- The words of an answer no longer always stay as the model wrote them, which `verify` still keeps for actions.
