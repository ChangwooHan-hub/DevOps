import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const port = Number(process.env.PORT ?? 3000);

  await app.listen(port);
  Logger.log(`webhook-api listening on ${port}`, 'Bootstrap');
}

void bootstrap();

