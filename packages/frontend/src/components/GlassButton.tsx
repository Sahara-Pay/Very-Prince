"use client";

import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

const baseStyles =
  "inline-flex items-center justify-center gap-2 rounded-2xl px-6 py-3 text-sm font-semibold transition duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-stellar-blue disabled:cursor-not-allowed disabled:opacity-50";

const variantStyles: Record<"primary" | "secondary", string> = {
  primary:
    "bg-gradient-to-r from-stellar-purple to-brand-500 text-white shadow-lg shadow-stellar-purple/25 hover:brightness-110",
  secondary:
    "border border-white/15 bg-white/10 text-white/80 hover:bg-white/15 hover:text-white",
};


type GlassButtonProps =
  | (AnchorHTMLAttributes<HTMLAnchorElement> & {
      variant?: "primary" | "secondary";
      href: string;
      children: ReactNode;
      className?: string;
    })
  | (ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: "primary" | "secondary";
      href?: undefined;
      children: ReactNode;
      className?: string;
    });

export function GlassButton({ variant = "primary", className, children, ...props }: GlassButtonProps) {
  const combinedClassName = `${baseStyles} ${variantStyles[variant]} ${className || ""}`.trim();

  if ("href" in props) {
    return (
      <a className={combinedClassName} {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {children}
      </a>
    );
  }



  return (
    <button className={combinedClassName} {...(props as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  );
}

type PrimaryButtonProps =
  | (Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className"> & {
      href: string;
      children: ReactNode;
      className?: string;
    })
  | (Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
      href?: undefined;
      children: ReactNode;
      className?: string;
    });

type SecondaryButtonProps =
  | (Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className"> & {
      href: string;
      children: ReactNode;
      className?: string;
    })
  | (Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
      href?: undefined;
      children: ReactNode;
      className?: string;
    });

export function PrimaryButton(props: PrimaryButtonProps) {
  return <GlassButton variant="primary" {...props} />;
}

export function SecondaryButton(props: SecondaryButtonProps) {
  return <GlassButton variant="secondary" {...props} />;
}
