import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm transition-colors disabled:opacity-50 disabled:pointer-events-none", {
  variants: {
    variant: {
      default: "bg-win text-black font-bold hover:bg-win/85 px-4 py-2",
      w95: "w95-btn",
      outline: "border border-border bg-transparent hover:bg-muted px-3 py-1.5",
      ghost: "hover:bg-muted px-2 py-1",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant }), className)} ref={ref} {...props} />;
});
Button.displayName = "Button";
