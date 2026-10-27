import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, get, type CompareResponse } from "./api";
import { useUi } from "./state/store";

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: get.me, staleTime: 60_000 });
}

export function useInfo(id: string | null) {
  return useQuery({ queryKey: ["info", id], queryFn: () => get.info(id!), enabled: !!id, staleTime: 300_000, retry: false });
}

export function useBundle(id: string | null) {
  return useQuery({ queryKey: ["bundle", id], queryFn: () => get.bundle(id!), enabled: !!id, staleTime: Infinity, retry: false });
}

export function useCircuit(id: string | null) {
  return useQuery({ queryKey: ["circuit", id], queryFn: () => get.circuit(id!), enabled: !!id, staleTime: Infinity, retry: false });
}

export function useLaps(id: string | null, driver: number | null) {
  return useQuery({ queryKey: ["laps", id, driver], queryFn: () => get.laps(id!, driver!), enabled: !!id && driver !== null, staleTime: 300_000 });
}

export interface CompareArgs {
  a: { sessionId: string; driverNumber: number; lapNumber?: number };
  b: { sessionId: string; driverNumber: number; lapNumber?: number };
  resolution: number;
}

export function useCompare(args: CompareArgs | null) {
  return useQuery({
    queryKey: ["compare", args],
    queryFn: () =>
      api<CompareResponse>("/api/analysis/compare", {
        method: "POST",
        body: { a: args!.a, b: args!.b, stepMetres: 5, includeTraces: true, traceResolutionMetres: args!.resolution },
      }),
    enabled: !!args,
    staleTime: Infinity,
    retry: false,
  });
}

/** Comparison of the two drivers selected in the timing tower (fastest laps, current session). */
export function useSelectionCompare() {
  const { sessionId, driverA, driverB } = useUi();
  const args = useMemo<CompareArgs | null>(
    () => (sessionId && driverA !== null && driverB !== null ? { a: { sessionId, driverNumber: driverA }, b: { sessionId, driverNumber: driverB }, resolution: 10 } : null),
    [sessionId, driverA, driverB],
  );
  return useCompare(args);
}
