import { describe, expect, it } from "vitest";
import { detectGateway, gatewayForHost } from "../src/gateways";

describe("gateways", () => {
  it("recognises security gateways from MX hosts", () => {
    expect(gatewayForHost("mx0a-001b2d01.pphosted.com.")).toBe("Proofpoint");
    expect(gatewayForHost("us-smtp-inbound-1.mimecast.com")).toBe("Mimecast");
    expect(gatewayForHost("d123.ess.barracuda.com")).toBe("Barracuda");
    expect(gatewayForHost("mx1.hc1234-56.iphmx.com")).toBe("Cisco");
    expect(gatewayForHost("aspmx.l.google.com")).toBeNull();
    expect(gatewayForHost("contoso-com.mail.protection.outlook.com")).toBeNull();
    expect(gatewayForHost("mailstream-east.mxrecord.io")).toBe("Cloudflare Area 1");
  });

  it("checks each business domain once and skips consumer providers", async () => {
    const asked: string[] = [];
    const resolve = async (d: string) => {
      asked.push(d);
      return d === "acme.com" ? ["mx0b-00112233.pphosted.com."] : ["mx.other.org."];
    };
    const found = await detectGateway(
      ["a@gmail.com", "b@Other.org", "c@acme.com", "d@acme.com", "not-an-email"],
      resolve,
    );
    expect(found).toEqual({ gateway: "Proofpoint", complete: true });
    expect(asked.sort()).toEqual(["acme.com", "other.org"]);
  });

  it("never throws when DNS fails", async () => {
    const found = await detectGateway(["a@acme.com"], async () => {
      throw new Error("timeout");
    });
    expect(found).toEqual({ gateway: null, complete: false }); // try again later
  });
});
