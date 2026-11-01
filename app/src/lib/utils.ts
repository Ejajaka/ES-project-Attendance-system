import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Merges Tailwind class strings; used by every shadcn/ui (react-native-reusables) component.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
