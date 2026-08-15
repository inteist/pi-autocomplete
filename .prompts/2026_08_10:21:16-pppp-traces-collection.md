there is initial implementation of collection of the traces. I want you to
review and make sure that we collect the traces. I think currently the
collection of traces happens in each folder but this is inconvenient I want the
collection to happen in one centralized place in for exmaple ~/.pi/ac-traces or
perhaps in the autocomplete extension folder in .../traces folder. The trace
should have enough debugging information to be useful later for the purposes of
analyzing them and learning from the traces on how to improve the implementation
in terms of prompting etc. so The traces should include the prefix, the existing
prefix of the text that is there, the suggestion, whether it was accepted or
not, what was typed. If the suggestion was not accepted, what was typed instead,
so we can compare what was suggested against what was actually typed. I am
thinking a daily jsonl file for traces where each line in the jsonl is the json
object of the trace, similar to how the agent traces are collected. perhaps it
makes sense to adopt a variation of https://agent-trace.dev/ since this is not
an agent trace, rather autocomplete trace, we probably need a much simpler
schema.

I leave it to your judgement to decide on the best schema to collect these
prompt autocomplete traces.

put significant effort into figuring out what the trace schema/shape should be
and then implement the recording end to end
