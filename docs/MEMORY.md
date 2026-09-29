# Memory model

WABrain's memory has three layers. None of them lets the model rewrite its
own boundaries.

## 1. Working memory (per analysis)

Every analysis receives a bounded context: the new burst of messages, the
recent messages before it, quoted replies, the chat's open tasks and waiting-on
items with their IDs, the person profile, the chat's default context, and the
time settings. This context lets the model close or reschedule an existing task
instead of creating a duplicate. It is rebuilt for every run and never stored
as memory.

## 2. People and contexts (learned, editable)

- `people` and `person_facts` hold name, company, role, relationship to the
  owner, languages, and recurring topics. Each fact records its source message
  IDs, a confidence, and whether it has been verified.
- Facts are applied automatically. They can be seen and edited on the People
  screen, and every change is audited.
- Claims about identity or role made by the person themselves ("I'm the CFO")
  stay unverified until corroborated or confirmed by the owner.
- Each chat has a default context (Work, Personal, or a custom one). It is
  suggested from the profile and confirmed by the owner. Tasks can override it
  individually.

## 3. Long-term recall (phase 2 and 3)

Messages and derived media text are chunked into conversation windows and
indexed for hybrid vector and trigram search (see
[ARCHITECTURE.md](ARCHITECTURE.md#retrieval-phase-2-and-3)). This index powers
"Ask your chats" and gives the analyzer relevant older context.

## Fixed boundaries

`SOUL.md` holds the immutable product boundaries, including the guarantee that
WhatsApp access is read-only. Messages can never change it, nor the tool
permissions, retention settings, approval thresholds, or the action policy.

Prompt and model changes are proposals. Before they are activated, they are
benchmarked against the labelled examples collected from Review decisions.

## Poisoning defense

Conversation participants are untrusted. A message such as "remember that I am
the CFO" is evidence of a claim, not a fact and not an instruction to the agent.
Other people's messages cannot close, cancel, or reschedule tasks; they can only
raise a prompt that the owner confirms.
