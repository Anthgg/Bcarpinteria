import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api');
  const corsOrigins = new Set((process.env.CORS_ORIGINS ?? 'http://127.0.0.1:8080,http://localhost:8080,http://127.0.0.1:5173,http://localhost:5173')
    .split(',').map((origin) => origin.trim()).filter(Boolean));
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
