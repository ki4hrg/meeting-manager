"use client";

import { useRef, useState } from "react";
import { Checkbox, Field, Textarea } from "@/components/ui/Field";

/**
 * Answering a question can also record a decision: its own linked record, in
 * its own words. Ticked, it opens on the answer as typed so far, to reword.
 */
export function RecordDecision() {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<string | null>(null);

  function toggle(on: boolean) {
    const answer = ref.current?.closest("form")?.elements.namedItem("answer");
    setText(
      on ? (answer instanceof HTMLTextAreaElement ? answer.value : "") : null,
    );
  }

  return (
    <div ref={ref} className="flex flex-col gap-3">
      <Checkbox
        label="Also record a decision"
        checked={text !== null}
        onChange={(event) => toggle(event.target.checked)}
      />
      {text !== null ? (
        <Field label="Decision">
          <Textarea
            name="decision"
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
      ) : null}
    </div>
  );
}
