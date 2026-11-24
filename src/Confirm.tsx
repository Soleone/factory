import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AnchoredDialogContent } from "@/components/variants/dialog";

type Question = {
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
};

type Pending = Question & { answer: (yes: boolean) => void };

let show: ((pending: Pending) => void) | undefined;

/** Asks in a dialog instead of the browser's own confirm; resolves true when the user agrees. */
export function confirm(question: Question) {
  return new Promise<boolean>((answer) => show?.({ ...question, answer }));
}

/** Mounted once at the root so `confirm` has somewhere to render. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending>();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    show = (next) => {
      setPending(next);
      setOpen(true);
    };
    return () => {
      show = undefined;
    };
  }, []);

  const close = (yes: boolean) => {
    pending?.answer(yes);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close(false)}>
      {pending && (
        <AnchoredDialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{pending.title}</DialogTitle>
            <DialogDescription>{pending.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Go back</DialogClose>
            <Button
              variant={pending.destructive ? "destructive" : "default"}
              onClick={() => close(true)}
            >
              {pending.action}
            </Button>
          </DialogFooter>
        </AnchoredDialogContent>
      )}
    </Dialog>
  );
}
