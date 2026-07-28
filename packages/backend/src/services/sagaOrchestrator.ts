import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { logger } from "../utils/logger.js";

type SagaPrismaClient = typeof prisma | Prisma.TransactionClient;

export type SagaStepContext<TState extends Record<string, unknown>> = {
  sagaId: string;
  state: TState;
  prisma: SagaPrismaClient;
};

export type SagaStep<TState extends Record<string, unknown>, TResult = unknown> = {
  name: string;
  execute: (context: SagaStepContext<TState>) => Promise<TResult>;
  compensate?: (context: SagaStepContext<TState>, result: TResult) => Promise<void>;
};

type CompletedSagaStep<TState extends Record<string, unknown>> = {
  step: SagaStep<TState>;
  result: unknown;
};

export class SagaCompensationError extends Error {
  constructor(
    message: string,
    readonly originalError: unknown,
    readonly compensationErrors: unknown[]
  ) {
    super(message);
    this.name = "SagaCompensationError";
  }
}

export class SagaOrchestrator<TState extends Record<string, unknown>> {
  constructor(private readonly prismaClient: typeof prisma = prisma) {}

  async run<TResult>(params: {
    sagaId: string;
    state: TState;
    steps: SagaStep<TState>[];
    onSuccess?: (context: SagaStepContext<TState>) => Promise<TResult>;
  }): Promise<TResult | undefined> {
    const completedSteps: CompletedSagaStep<TState>[] = [];
    const context = this.createContext(params.sagaId, params.state, this.prismaClient);
    let currentState = "NONE";

    await this.logTransition(params.sagaId, currentState, "STARTED", "SAGA_STARTED", {
      steps: params.steps.map((step) => step.name),
    });
    currentState = "STARTED";

    try {
      for (const step of params.steps) {
        const startedState = `${step.name}:STARTED`;
        const completedState = `${step.name}:COMPLETED`;

        await this.logTransition(params.sagaId, currentState, startedState, "STEP_STARTED");
        const result = await this.prismaClient.$transaction((txPrisma) =>
          step.execute(this.createContext(params.sagaId, params.state, txPrisma))
        );
        completedSteps.push({ step, result });

        await this.logTransition(params.sagaId, startedState, completedState, "STEP_COMPLETED");
        currentState = completedState;
      }

      const result = await params.onSuccess?.(context);
      await this.logTransition(params.sagaId, currentState, "SUCCESS", "SAGA_SUCCEEDED");
      return result;
    } catch (error) {
      await this.compensate(params.sagaId, params.state, currentState, completedSteps, error);
      return undefined;
    }
  }

  private async compensate(
    sagaId: string,
    state: TState,
    fromState: string,
    completedSteps: CompletedSagaStep<TState>[],
    originalError: unknown
  ): Promise<never> {
    const compensationErrors: unknown[] = [];

    logger.warn({ err: originalError, sagaId }, "[Saga] Step failed; starting compensation");
    await this.logTransition(sagaId, fromState, "COMPENSATING", "SAGA_COMPENSATING", {
      error: this.errorMessage(originalError),
    });

    for (const completedStep of [...completedSteps].reverse()) {
      if (!completedStep.step.compensate) {
        continue;
      }

      const compensationStarted = `${completedStep.step.name}:COMPENSATE_STARTED`;
      const compensationCompleted = `${completedStep.step.name}:COMPENSATED`;

      try {
        await this.logTransition(sagaId, "COMPENSATING", compensationStarted, "COMPENSATION_STARTED");
        await this.prismaClient.$transaction((txPrisma) =>
          completedStep.step.compensate!(
            this.createContext(sagaId, state, txPrisma),
            completedStep.result
          )
        );
        await this.logTransition(sagaId, compensationStarted, compensationCompleted, "COMPENSATION_COMPLETED");
      } catch (compensationError) {
        compensationErrors.push(compensationError);
        logger.error(
          { err: compensationError, sagaId, step: completedStep.step.name },
          "[Saga] Compensation handler failed"
        );
      }
    }

    await this.logTransition(sagaId, "COMPENSATING", "FAILED", "SAGA_FAILED", {
      error: this.errorMessage(originalError),
      compensationErrors: compensationErrors.map((error) => this.errorMessage(error)),
    });

    if (compensationErrors.length > 0) {
      throw new SagaCompensationError(
        "Saga failed and one or more compensation handlers failed",
        originalError,
        compensationErrors
      );
    }

    throw originalError;
  }

  private createContext(
    sagaId: string,
    state: TState,
    prismaClient: SagaPrismaClient
  ): SagaStepContext<TState> {
    return { sagaId, state, prisma: prismaClient };
  }

  private async logTransition(
    sagaId: string,
    fromState: string,
    toState: string,
    event: string,
    payload?: Record<string, unknown>
  ) {
    logger.info({ sagaId, fromState, toState, event, payload }, `[Saga] ${event}: ${fromState} -> ${toState}`);

    try {
      await this.prismaClient.sagaAuditLog.create({
        data: {
          sagaId,
          fromState,
          toState,
          event,
          payload: payload ? JSON.stringify(payload) : null,
        },
      });
    } catch (error) {
      logger.error({ err: error, sagaId, fromState, toState, event }, "[Saga] Failed to write audit log");
    }
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

export const sagaOrchestrator = new SagaOrchestrator();
