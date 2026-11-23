import { useState } from "react";
import type { DialogAnswer, PiDialog } from "@/pi";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AnchoredDialogContent } from "@/components/variants/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** A question from one of Pi's extensions; closing it cancels. */
export function AgentDialog({
  dialog,
  onAnswer,
}: {
  dialog: PiDialog;
  onAnswer: (answer: DialogAnswer) => void;
}) {
  const [text, setText] = useState(dialog.method === "editor" ? (dialog.prefill ?? "") : "");
  const typed = dialog.method === "input" || dialog.method === "editor";

  return (
    <Dialog open onOpenChange={(open) => !open && onAnswer({ cancelled: true })}>
      <AnchoredDialogContent>
        <DialogHeader>
          <DialogTitle>{dialog.title}</DialogTitle>
          {dialog.method === "confirm" && dialog.message && (
            <DialogDescription>{dialog.message}</DialogDescription>
          )}
        </DialogHeader>
        {dialog.method === "input" && (
          <Input
            autoFocus
            value={text}
            placeholder={dialog.placeholder}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && onAnswer({ value: text })}
          />
        )}
        {dialog.method === "editor" && (
          <Textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} />
        )}
        <DialogFooter>
          {dialog.method === "select" &&
            dialog.options.map((option) => (
              <Button key={option} variant="outline" onClick={() => onAnswer({ value: option })}>
                {option}
              </Button>
            ))}
          {dialog.method === "confirm" && (
            <>
              <Button variant="outline" onClick={() => onAnswer({ confirmed: false })}>
                No
              </Button>
              <Button autoFocus onClick={() => onAnswer({ confirmed: true })}>
                Yes
              </Button>
            </>
          )}
          {typed && <Button onClick={() => onAnswer({ value: text })}>Send</Button>}
        </DialogFooter>
      </AnchoredDialogContent>
    </Dialog>
  );
}
