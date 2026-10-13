"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";

/** The signed-in user. Staff (admin, operator) also get the expert tools:
 * imports, mosaic rebuilds, recomputes, field owners. */
export function useMe() {
  const { data: me, isPending } = useQuery<User>({
    queryKey: ["me"],
    queryFn: api.me,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return {
    me: me ?? null,
    isPending,
    isStaff: me?.role === "admin" || me?.role === "operator",
    isAdmin: me?.role === "admin",
  };
}

export const ROLE_LABEL: Record<User["role"], string> = {
  admin: "Admin",
  operator: "Operator",
  farmer: "Farmer",
};
