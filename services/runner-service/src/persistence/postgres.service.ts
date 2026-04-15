import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResult, QueryResultRow } from 'pg';

@Injectable()
export class PostgresService implements OnModuleDestroy {
  private readonly logger = new Logger(PostgresService.name);
  private readonly pool?: Pool;

  constructor(private readonly configService: ConfigService) {
    const databaseUrl = this.configService.get<string>('DATABASE_URL');
    if (!databaseUrl) {
      this.logger.warn('DATABASE_URL is not set. agent run records will not be persisted.');
      return;
    }

    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: this.configService.get<string>('DATABASE_SSL') === 'true' ? { rejectUnauthorized: false } : undefined
    });
  }

  get enabled() {
    return Boolean(this.pool);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('postgres is not configured');
    }
    return this.pool.query<T>(text, values);
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
    }
  }
}
