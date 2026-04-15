import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3002);

  await app.listen(port);
  Logger.log(`runner-service listening on ${port}`, 'Bootstrap');
}

void bootstrap();

