import { clamp01, createLogger, migrate, openDb, type AppConfig, type Db, type MessageBus } from '@rhc/core';
import type { DeployerScore, GraduationEvent, LaunchOutcome, NewLaunchEvent } from '@rhc/types';
import { HUB_OUT_DEGREE_THRESHOLD, type FundingSourceResolver } from './funding-source.js';

const log = createLogger('deployer-graph');

interface DeployerRow {
  address: string;
  funder: string | null;
  funder_kind: string;
  funder_out_degree: number | null;
  cluster_id: string;
  first_seen: number;
  resolved: number;
}

interface LaunchRow {
  token_address: string;
  deployer: string;
  launchpad_id: string;
  launched_at: number;
  outcome: LaunchOutcome;
  peak_progress: number;
  evaluated_at: number | null;
}

/**
 * Phase 2: the deployer funding graph.
 *
 * A standing service, not per-trade logic. It records every launch it sees regardless of
 * whether the bot trades it, resolves who funded each deployer, clusters deployers that
 * share a funding source, and grades prior launches by what actually happened to them.
 *
 * It is worth starting before anything consumes it, because its value is entirely a
 * function of how long it has been running: on day one nearly every deployer is unknown,
 * and after a week the repeat launchers — the population that matters — are visible.
 *
 * Clustering deliberately refuses to group wallets funded by a high-out-degree source.
 * Everyone who withdrew from the same exchange shares a funder, and treating that as a
 * relationship would merge thousands of unrelated deployers into a single cluster whose
 * statistics mean nothing.
 */
export class DeployerGraphService {
  private readonly db: Db;
  private readonly pending = new Set<string>();
  private evaluationTimer: NodeJS.Timeout | null = null;

  readonly stats = { deployersKnown: 0, launchesRecorded: 0, resolved: 0, unresolved: 0, clusters: 0 };

  constructor(
    private readonly config: AppConfig,
    private readonly resolver: FundingSourceResolver,
    private readonly bus: MessageBus,
  ) {
    this.db = openDb(config.bot.deployerGraph.dbPath);
    migrate(this.db, 'deployer-graph', [
      `CREATE TABLE deployers (
         address TEXT PRIMARY KEY,
         funder TEXT,
         funder_kind TEXT NOT NULL DEFAULT 'unknown',
         funder_out_degree INTEGER,
         cluster_id TEXT NOT NULL,
         first_seen INTEGER NOT NULL,
         resolved INTEGER NOT NULL DEFAULT 0
       );
       CREATE INDEX idx_deployers_cluster ON deployers(cluster_id);
       CREATE INDEX idx_deployers_funder ON deployers(funder);`,
      `CREATE TABLE launches (
         token_address TEXT PRIMARY KEY,
         deployer TEXT NOT NULL,
         launchpad_id TEXT NOT NULL,
         launched_at INTEGER NOT NULL,
         outcome TEXT NOT NULL DEFAULT 'pending',
         peak_progress REAL NOT NULL DEFAULT 0,
         evaluated_at INTEGER
       );
       CREATE INDEX idx_launches_deployer ON launches(deployer);
       CREATE INDEX idx_launches_outcome ON launches(outcome);`,
    ]);
  }

  start(): void {
    this.bus.subscribe('launch.new', (event) => this.onLaunch(event));
    this.bus.subscribe('launch.graduated', (event) => this.onGraduation(event));

    // Outcomes are graded on a timer rather than on an event, because "nothing happened"
    // is itself an outcome and produces no event to react to.
    this.evaluationTimer = setInterval(() => this.evaluatePending(), 60_000);

    this.refreshStats();
    log.info('deployer graph started', {
      resolver: this.resolver.name,
      resolverAvailable: this.resolver.available,
      knownDeployers: this.stats.deployersKnown,
      recordedLaunches: this.stats.launchesRecorded,
    });
  }

  stop(): void {
    if (this.evaluationTimer) clearInterval(this.evaluationTimer);
    this.evaluationTimer = null;
    this.db.close();
  }

  /** Record a launch and, for a deployer we have not seen, resolve its funding source. */
  private onLaunch(event: NewLaunchEvent): void {
    const deployer = event.deployerAddress;

    this.db.run(
      `INSERT OR IGNORE INTO launches (token_address, deployer, launchpad_id, launched_at, outcome)
       VALUES (?, ?, ?, ?, 'pending')`,
      event.tokenAddress,
      deployer,
      event.launchpadId,
      event.timestamp,
    );

    const existing = this.db.get<DeployerRow>('SELECT * FROM deployers WHERE address = ?', deployer);
    if (!existing) {
      this.db.run(
        `INSERT OR IGNORE INTO deployers (address, cluster_id, first_seen, resolved) VALUES (?, ?, ?, 0)`,
        deployer,
        soloCluster(deployer),
        event.timestamp,
      );
      void this.resolveFunding(deployer);
    }

    this.refreshStats();
  }

  private onGraduation(event: GraduationEvent): void {
    this.db.run(
      "UPDATE launches SET outcome = 'graduated', peak_progress = 1.0, evaluated_at = ? WHERE token_address = ?",
      Date.now(),
      event.tokenAddress,
    );
  }

  /** Track how far a launch got, so a stalled launch can be told from a live one. */
  recordProgress(tokenAddress: string, progress: number): void {
    this.db.run(
      'UPDATE launches SET peak_progress = MAX(peak_progress, ?) WHERE token_address = ?',
      progress,
      tokenAddress.toLowerCase(),
    );
  }

  private async resolveFunding(deployer: string): Promise<void> {
    if (this.pending.has(deployer) || !this.resolver.available) return;
    this.pending.add(deployer);

    try {
      const attribution = await this.resolver.resolve(deployer);

      // Only a low-out-degree funder implies shared control. Anything hub-like leaves
      // the deployer in its own cluster.
      const clusterable =
        attribution.funder != null &&
        attribution.funderOutDegree != null &&
        attribution.funderOutDegree < HUB_OUT_DEGREE_THRESHOLD;

      this.db.run(
        `UPDATE deployers SET funder = ?, funder_kind = ?, funder_out_degree = ?, cluster_id = ?, resolved = 1
         WHERE address = ?`,
        attribution.funder,
        attribution.kind,
        attribution.funderOutDegree,
        clusterable ? `fund:${attribution.funder}` : soloCluster(deployer),
        deployer,
      );

      this.refreshStats();
    } finally {
      this.pending.delete(deployer);
    }
  }

  /**
   * Grade launches that have had enough time to show what they are.
   *
   * A launch that graduated is a success. One that made real progress and then went
   * quiet is stalled. One that barely moved is a dud — and on this launchpad "dumped"
   * means abandoned rather than rugged, since liquidity cannot be pulled from a curve.
   */
  private evaluatePending(): void {
    const cutoff = Date.now() - this.config.bot.deployerGraph.outcomeEvaluationMinutes * 60_000;
    const rows = this.db.all<LaunchRow>(
      "SELECT * FROM launches WHERE outcome = 'pending' AND launched_at < ? LIMIT 500",
      cutoff,
    );

    for (const row of rows) {
      const outcome: LaunchOutcome =
        row.peak_progress >= this.config.bot.deployerGraph.stalledProgressThreshold ? 'stalled' : 'dumped';
      this.db.run(
        'UPDATE launches SET outcome = ?, evaluated_at = ? WHERE token_address = ?',
        outcome,
        Date.now(),
        row.token_address,
      );
    }

    if (rows.length > 0) log.debug('graded launch outcomes', { count: rows.length });
  }

  /**
   * Score a deployer. Returns a neutral score with near-zero confidence for anyone
   * unknown — the decision engine is expected to size on both, so that a fresh wallet
   * cannot read the same as a proven one.
   */
  score(deployerAddress: string): DeployerScore {
    const address = deployerAddress.toLowerCase();
    const { deployerGraph } = this.config.bot;
    const row = this.db.get<DeployerRow>('SELECT * FROM deployers WHERE address = ?', address);
    const clusterId = row?.cluster_id ?? soloCluster(address);

    const own = this.outcomeCounts('deployer', address);
    const cluster = this.outcomeCounts('cluster', clusterId);
    const clusterSize =
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deployers WHERE cluster_id = ?', clusterId)?.n ?? 1;

    const priorLaunchCount = own.graded;
    const priorSuccessRate = own.graded > 0 ? own.graduated / own.graded : 0;
    const clusterSuccessRate = cluster.graded > 0 ? cluster.graduated / cluster.graded : 0;

    const isKnownRugCluster =
      cluster.graded >= deployerGraph.minLaunchesForConfidence &&
      cluster.dumped / cluster.graded >= deployerGraph.rugClusterThreshold;

    const reasons: string[] = [];
    let score = deployerGraph.unknownDeployerScore;

    // Confidence scales with graded history and saturates at the configured minimum, so
    // a single lucky launch cannot masquerade as a track record.
    const evidence = Math.max(own.graded, cluster.graded);
    const confidence = clamp01(evidence / (deployerGraph.minLaunchesForConfidence * 2));

    if (evidence === 0) {
      reasons.push(row?.resolved ? 'no graded prior launches' : 'deployer not yet resolved');
    } else {
      // Blend the deployer's own record with its cluster's, weighted toward whichever
      // has more evidence behind it.
      const ownWeight = own.graded / (own.graded + cluster.graded || 1);
      const blended = priorSuccessRate * ownWeight + clusterSuccessRate * (1 - ownWeight);

      // Graduation is rare, so a raw success rate compresses everything near zero.
      // Rescaling keeps the score usable while still ordering deployers correctly.
      score = clamp01(0.25 + blended * 3);
      reasons.push(
        `${own.graduated}/${own.graded} own launches graduated, ${cluster.graduated}/${cluster.graded} across cluster`,
      );
    }

    if (isKnownRugCluster) {
      score = 0;
      reasons.push('cluster is dominated by abandoned launches');
    }

    if (clusterSize > 1) reasons.push(`clustered with ${clusterSize - 1} other deployer(s) by shared funder`);
    if (row?.funder_kind === 'cex') reasons.push('funded from a high-fanout source; no cluster signal');
    if (!this.resolver.available) reasons.push('no funding-source resolver configured');

    return {
      kind: 'deployer-score',
      deployerAddress: address as DeployerScore['deployerAddress'],
      clusterId,
      priorLaunchCount,
      priorSuccessRate,
      isKnownRugCluster,
      fundingSource: (row?.funder ?? null) as DeployerScore['fundingSource'],
      fundingSourceKind: (row?.funder_kind ?? 'unknown') as DeployerScore['fundingSourceKind'],
      clusterSize,
      clusterLaunchCount: cluster.graded,
      clusterSuccessRate,
      score,
      confidence,
      reasons,
      timestamp: Date.now(),
    };
  }

  private outcomeCounts(scope: 'deployer' | 'cluster', key: string): {
    graded: number;
    graduated: number;
    dumped: number;
  } {
    const where =
      scope === 'deployer'
        ? 'l.deployer = ?'
        : 'l.deployer IN (SELECT address FROM deployers WHERE cluster_id = ?)';

    const row = this.db.get<{ graded: number; graduated: number; dumped: number }>(
      `SELECT
         COUNT(*) AS graded,
         SUM(CASE WHEN l.outcome = 'graduated' THEN 1 ELSE 0 END) AS graduated,
         SUM(CASE WHEN l.outcome = 'dumped' THEN 1 ELSE 0 END) AS dumped
       FROM launches l
       WHERE ${where} AND l.outcome != 'pending'`,
      key,
    );

    return { graded: row?.graded ?? 0, graduated: row?.graduated ?? 0, dumped: row?.dumped ?? 0 };
  }

  private refreshStats(): void {
    this.stats.deployersKnown = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deployers')?.n ?? 0;
    this.stats.launchesRecorded = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM launches')?.n ?? 0;
    this.stats.resolved = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deployers WHERE resolved = 1')?.n ?? 0;
    this.stats.unresolved = this.stats.deployersKnown - this.stats.resolved;
    this.stats.clusters =
      this.db.get<{ n: number }>('SELECT COUNT(DISTINCT cluster_id) AS n FROM deployers')?.n ?? 0;
  }

  /** Largest multi-wallet clusters, for the dashboard. */
  topClusters(limit = 8): Array<{ clusterId: string; size: number; launches: number; graduated: number }> {
    return this.db.all(
      `SELECT d.cluster_id AS clusterId,
              COUNT(DISTINCT d.address) AS size,
              COUNT(l.token_address) AS launches,
              SUM(CASE WHEN l.outcome = 'graduated' THEN 1 ELSE 0 END) AS graduated
       FROM deployers d
       LEFT JOIN launches l ON l.deployer = d.address
       GROUP BY d.cluster_id
       HAVING size > 1
       ORDER BY size DESC, launches DESC
       LIMIT ?`,
      limit,
    );
  }
}

function soloCluster(address: string): string {
  return `solo:${address}`;
}
