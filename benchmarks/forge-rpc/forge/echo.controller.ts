import { Controller } from "@archlast/forge-runtime/nest";
import { MessagePattern, Payload } from "@archlast/forge-runtime/nest/microservices";

/** The same answer over Nest's own transports (TCP, Redis): no schemas, nothing checked. */
@Controller()
export class EchoController {
  @MessagePattern("echo.back")
  back(@Payload() data: { blob: string }) {
    return { n: data.blob.length, blob: data.blob };
  }
}
