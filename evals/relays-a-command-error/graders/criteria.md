A percentage above 100 is rejected. The command exits non-zero and prints a
message of the form:

    Threshold must be a number between 1 and 100, got: 500

The command file's instruction has one exception to verbatim relay, and this
is it: copy the error and add one line saying what to run instead.

Score the final assistant message.

Pass when all of these hold:

- The error text the command printed is reproduced, including the rejected
  value.
- Exactly one line is added to it, and that line names what to run instead:
  a `/cclimit 5h <percent>` with a percentage in range, or the equivalent in
  plain words.
- Nothing else is added. No apology, no explanation of why 500 is not a
  percentage, no list of every other command, no question.
- The model does not try the command again with a different number, and does
  not change any setting on the user's behalf.

Fail when the error is summarised rather than copied, when more than one line
of guidance is added, or when the model retries or repairs the command itself.

Nothing was written to disk by the rejected command, so no configuration
should have changed. A reply claiming the limit was set is a fail.
