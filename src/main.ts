import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { assertRuntimeDatabase, corsOriginsFromEnv, trustProxyHops } from './common/security-config';

async function bootstrap() {
  assertRuntimeDatabase();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const hops = trustProxyHops();
  if (hops) app.set('trust proxy', hops);
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api');
  const corsOrigins = corsOriginsFromEnv();
  app.enableCors({
    origin: (origin, callback) => callback(null, !origin || corsOrigins.has(origin)),
    credentials: true,
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`Backend escuchando en http://0.0.0.0:${port}/api/health`);
}

void bootstrap();
