import type { ProviderRegistry } from "@lemon-tea/provider-sdk";
import { AccessPolicy } from "./access.ts";
import { IngestionService } from "./ingestion.ts";
import { JobService } from "./jobs.ts";
import type { IngestStore, Store } from "./store.ts";
import { LapComparisonService } from "./services/analysis.ts";
import { CircuitService } from "./services/circuit.ts";
import {
  ModelEvaluationService,
  PracticeAnalysisService,
  QualifyingPredictionService,
  RacePacePredictionService,
  StrategySimulationService,
  TyreModelService,
} from "./services/predictions.ts";
import { SessionService } from "./services/session.ts";
import { TelemetryService } from "./services/telemetry.ts";
import { TimingService } from "./services/timing.ts";
import { ExportService } from "./services/export.ts";
import { ProviderAccountService, type AccountProviderTools } from "./services/connections.ts";

/**
 * The single analytical engine. REST routes, WebSocket handlers, MCP tools (remote and stdio)
 * and job runners all receive this object; none of them implement analytics themselves.
 */
export interface Services {
  store: Store;
  access: AccessPolicy;
  sessions: SessionService;
  timing: TimingService;
  telemetry: TelemetryService;
  circuits: CircuitService;
  laps: LapComparisonService;
  practice: PracticeAnalysisService;
  tyres: TyreModelService;
  qualifying: QualifyingPredictionService;
  racePace: RacePacePredictionService;
  strategy: StrategySimulationService;
  evaluation: ModelEvaluationService;
  jobs: JobService;
  exports: ExportService;
  ingestion: IngestionService | null;
  providers: ProviderRegistry;
  connections: ProviderAccountService;
}

export function createServices(deps: {
  store: Store;
  ingestStore?: IngestStore;
  providers: ProviderRegistry;
  extraPublicSources?: string[];
  onJobCreated?: (jobId: string) => Promise<void>;
  /** Providers that users connect with their own account (e.g. the Formula 1 account). */
  accountProviders?: Record<string, AccountProviderTools>;
  encryptionKey?: string;
}): Services {
  const { store, providers } = deps;
  const access = new AccessPolicy(store, deps.extraPublicSources ?? []);
  const timing = new TimingService(store, access);
  const telemetry = new TelemetryService(store, access);
  const practice = new PracticeAnalysisService(access, timing);
  return {
    store,
    access,
    providers,
    sessions: new SessionService(store, access, providers),
    timing,
    telemetry,
    circuits: new CircuitService(store, access, telemetry),
    laps: new LapComparisonService(store, access, telemetry),
    practice,
    tyres: new TyreModelService(store, practice),
    qualifying: new QualifyingPredictionService(store, access, practice),
    racePace: new RacePacePredictionService(store, access, practice),
    strategy: new StrategySimulationService(store, access, timing, practice),
    evaluation: new ModelEvaluationService(store, access, timing),
    jobs: new JobService(store, access, deps.onJobCreated),
    exports: new ExportService(store, access, telemetry),
    ingestion: deps.ingestStore ? new IngestionService(providers, deps.ingestStore, access) : null,
    connections: new ProviderAccountService(store, deps.encryptionKey, deps.accountProviders ?? {}),
  };
}
