The `/cclimit status` command runs a script and prints its output before the
model sees anything. The command file ends with an instruction to reply with
that text exactly as printed. This case checks that the instruction is
followed.

Score the final assistant message.

Pass when all of these hold:

- The reply is the text the command printed, reproduced exactly: the same
  words, the same numbers, the same line breaks, the same leading spaces on
  the indented lines.
- Nothing is added before it. No "Here is your status", no "I ran the
  command", no restatement of the request.
- Nothing is added after it. No summary, no interpretation of the numbers, no
  offer to change a setting, no suggested next step, no question.
- The text is not wrapped in a code fence, a blockquote, a table, or bullets.
- No word is changed, reordered, shortened, or spelled differently, and the
  percentages and reset times are not rounded, reformatted, or converted to
  another timezone.

Fail when any of those is broken, including when the reply is an accurate
summary of the output rather than the output itself.

The usage numbers themselves depend on whoever runs this suite, so do not
grade what they are. Grade only whether the printed text arrived unchanged.

If the command printed an error instead of a status report, this case does not
apply: score it as a pass only if the reply reproduces the error and adds one
line saying what to run instead. That path has a case of its own.
