import "./polyfill";
import {
  ApiFromModules,
  FunctionReference,
  GenericDataModel,
  type HttpRouter,
  actionGeneric,
  httpActionGeneric,
  GenericActionCtx,
} from "convex/server";
import {
  type ComponentApi,
  convertToDatabaseProduct,
  convertToDatabaseSubscription,
  RunMutationCtx,
  RunQueryCtx,
} from "../component/util";
import { Polar as PolarSdk } from "@polar-sh/sdk";
import { Infer, v } from "convex/values";
import schema from "../component/schema";
import { WebhookSubscriptionCreatedPayload } from "@polar-sh/sdk/models/components/webhooksubscriptioncreatedpayload.js";
import { WebhookSubscriptionUpdatedPayload } from "@polar-sh/sdk/models/components/webhooksubscriptionupdatedpayload.js";
import { WebhookProductCreatedPayload } from "@polar-sh/sdk/models/components/webhookproductcreatedpayload.js";
import { WebhookProductUpdatedPayload } from "@polar-sh/sdk/models/components/webhookproductupdatedpayload.js";
import { Checkout } from "@polar-sh/sdk/models/components/checkout.js";
import { CustomerSession } from "@polar-sh/sdk/models/components/customersession.js";
import {
  validateEvent,
  WebhookVerificationError,
} from "@polar-sh/sdk/webhooks";
import { EmptyObject } from "convex-helpers";

export const subscriptionValidator = schema.tables.subscriptions.validator;
export type Subscription = Infer<typeof subscriptionValidator>;

export type SubscriptionHandler = FunctionReference<
  "mutation",
  "internal",
  { subscription: Subscription }
>;

export type CheckoutApi<DataModel extends GenericDataModel> = ApiFromModules<{
  checkout: ReturnType<Polar<DataModel>["checkoutApi"]>;
}>["checkout"];

export class Polar<DataModel extends GenericDataModel> {
  private polar: PolarSdk;
  constructor(
    public component: ComponentApi,
    private options: {
      getUserInfo?: FunctionReference<
        "query",
        "internal",
        EmptyObject,
        { userId: string; email?: string }
      >;
    } = {}
  ) {
    this.polar = new PolarSdk({
      accessToken: process.env["POLAR_ORGANIZATION_TOKEN"] ?? "",
      server:
        (process.env["POLAR_SERVER"] as "sandbox" | "production") ?? "sandbox",
    });
  }
  getCustomerByUserId(ctx: RunQueryCtx, userId: string) {
    return ctx.runQuery(this.component.lib.getCustomerByUserId, { userId });
  }
  async createCheckoutSession(
    ctx: GenericActionCtx<DataModel>,
    {
      productId,
      userId,
      email,
      origin,
    }: { productId: string; userId: string; email: string; origin: string }
  ): Promise<Checkout> {
    const dbCustomer = await ctx.runQuery(
      this.component.lib.getCustomerByUserId,
      {
        userId,
      }
    );
    const customerId =
      dbCustomer?.id ||
      (
        await this.polar.customers.create({
          email,
          metadata: {
            userId,
          },
        })
      ).id;
    if (!dbCustomer) {
      await ctx.runMutation(this.component.lib.insertCustomer, {
        id: customerId,
        userId,
      });
    }
    return this.polar.checkouts.create({
      allowDiscountCodes: true,
      products: [productId],
      customerId,
      embedOrigin: origin,
    });
  }
  listProducts(
    ctx: RunQueryCtx,
    { includeArchived }: { includeArchived: boolean }
  ) {
    return ctx.runQuery(this.component.lib.listProducts, { includeArchived });
  }
  listUserSubscriptions(ctx: RunQueryCtx, { userId }: { userId: string }) {
    return ctx.runQuery(this.component.lib.listUserSubscriptions, { userId });
  }
  getSubscription(
    ctx: RunQueryCtx,
    { subscriptionId }: { subscriptionId: string }
  ) {
    return ctx.runQuery(this.component.lib.getSubscription, {
      id: subscriptionId,
    });
  }
  getProduct(ctx: RunQueryCtx, { productId }: { productId: string }) {
    return ctx.runQuery(this.component.lib.getProduct, { id: productId });
  }
  createCustomerPortalSession(
    ctx: GenericActionCtx<DataModel>,
    { customerId }: { customerId: string }
  ): Promise<CustomerSession> {
    return this.polar.customerSessions.create({
      customerId,
    });
  }
  checkoutApi(opts: {
    products: Record<string, string>;
    getUserInfo: (ctx: RunQueryCtx) => Promise<{
      userId: string;
      email: string;
    }>;
  }) {
    return {
      generateCheckoutLink: actionGeneric({
        args: {
          productKey: v.string(),
          origin: v.string(),
        },
        returns: v.object({
          url: v.string(),
        }),
        handler: async (ctx, args) => {
          const { userId, email } = await opts.getUserInfo(ctx);
          const { url } = await this.createCheckoutSession(ctx, {
            productId: opts.products?.[args.productKey],
            userId,
            email,
            origin: args.origin,
          });
          return { url };
        },
      }),
      generateCustomerPortalUrl: actionGeneric({
        args: {},
        returns: v.union(v.object({ url: v.string() }), v.null()),
        handler: async (ctx) => {
          const { userId } = await opts.getUserInfo(ctx);
          const customer = await ctx.runQuery(
            this.component.lib.getCustomerByUserId,
            { userId }
          );

          if (!customer) {
            return null;
          }

          const session = await this.createCustomerPortalSession(ctx, {
            customerId: customer.id,
          });

          return { url: session.customerPortalUrl };
        },
      }),
    };
  }
  registerRoutes(
    http: HttpRouter,
    {
      path = "/polar/events",
    }: {
      path?: string;
      onSubscriptionCreated?: (
        ctx: RunMutationCtx,
        event: WebhookSubscriptionCreatedPayload
      ) => Promise<void>;
      onSubscriptionUpdated?: (
        ctx: RunMutationCtx,
        event: WebhookSubscriptionUpdatedPayload
      ) => Promise<void>;
      onProductCreated?: (
        ctx: RunMutationCtx,
        event: WebhookProductCreatedPayload
      ) => Promise<void>;
      onProductUpdated?: (
        ctx: RunMutationCtx,
        event: WebhookProductUpdatedPayload
      ) => Promise<void>;
    } = {}
  ) {
    http.route({
      path,
      method: "POST",
      handler: httpActionGeneric(async (ctx, request) => {
        if (!request.body) {
          throw new Error("No body");
        }
        const body = await request.text();
        const headers = Object.fromEntries(request.headers.entries());
        try {
          const event = validateEvent(
            body,
            headers,
            process.env["POLAR_WEBHOOK_SECRET"] ?? ""
          );
          switch (event.type) {
            case "subscription.created": {
              const newSubscription = convertToDatabaseSubscription(event.data);

              const existingSubscriptions = await ctx.runQuery(
                this.component.lib.listCustomerSubscriptions,
                { customerId: newSubscription.customerId }
              );

              for (const subscription of existingSubscriptions) {
                if (
                  subscription.id !== newSubscription.id &&
                  subscription.status === "active" &&
                  !subscription.cancelAtPeriodEnd
                ) {
                  await this.polar.subscriptions.revoke({
                    id: subscription.id,
                  });
                }
              }

              await ctx.runMutation(this.component.lib.createSubscription, {
                subscription: newSubscription,
              });
              break;
            }
            case "subscription.updated": {
              await ctx.runMutation(this.component.lib.updateSubscription, {
                subscription: convertToDatabaseSubscription(event.data),
              });
              break;
            }
            case "product.created": {
              await ctx.runMutation(this.component.lib.createProduct, {
                product: convertToDatabaseProduct(event.data),
              });
              break;
            }
            case "product.updated": {
              await ctx.runMutation(this.component.lib.updateProduct, {
                product: convertToDatabaseProduct(event.data),
              });
              break;
            }
          }
          return new Response("Accepted", { status: 202 });
        } catch (error) {
          if (error instanceof WebhookVerificationError) {
            console.error(error);
            return new Response("Forbidden", { status: 403 });
          }
          throw error;
        }
      }),
    });
  }
}
