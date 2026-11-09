import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ItemsController } from "./items.controller";

@Controller()
class HealthController {
  @Get("health")
  health() {
    return "ok";
  }
}

@Module({ controllers: [ItemsController, HealthController] })
class AppModule {}

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}
void main();
