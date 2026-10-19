import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("tag", {
  variants: {
    variant: {
      default: "",
      win: "bg-lime text-ink",
      loss: "bg-coral text-ink",
      amber: "bg-sun text-ink",
      outline: "bg-transparent text-muted-foreground ring-1 ring-inset ring-chip",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
