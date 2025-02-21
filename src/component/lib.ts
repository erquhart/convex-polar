import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import schema from "./schema";
import { asyncMap } from "convex-helpers";

export const getCustomerByUserId = query({
  args: {
    userId: v.string(),
  },
  returns: v.union(
    v.object({
      ...schema.tables.customers.validator.fields,
      _id: v.id("customers"),
      _creationTime: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    return ctx.db
      .query("customers")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .unique();
  },
});

export const insertCustomer = mutation({
  args: {
    id: v.string(),
    userId: v.string(),
  },
  returns: v.id("customers"),
  handler: async (ctx, args) => {
    return ctx.db.insert("customers", {
      id: args.id,
      userId: args.userId,
    });
  },
});

export const upsertCustomer = mutation({
  args: {
    userId: v.string(),
    customerId: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const customer = await ctx.db
      .query("customers")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!customer) {
      const customerId = await ctx.db.insert("customers", {
        id: args.customerId,
        userId: args.userId,
      });
      const newCustomer = await ctx.db.get(customerId);
      if (!newCustomer) {
        throw new Error("Failed to create customer");
      }
      return newCustomer.id;
    }
    return customer.id;
  },
});

export const getSubscription = query({
  args: {
    id: v.id("subscriptions"),
  },
  returns: v.union(
    v.object({
      ...schema.tables.subscriptions.validator.fields,
      _id: v.id("subscriptions"),
      _creationTime: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    return ctx.db
      .query("subscriptions")
      .withIndex("id", (q) => q.eq("id", args.id))
      .unique();
  },
});

export const getProduct = query({
  args: {
    id: v.id("products"),
  },
  returns: v.union(
    v.object({
      ...schema.tables.products.validator.fields,
      _id: v.id("products"),
      _creationTime: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    return ctx.db
      .query("products")
      .withIndex("id", (q) => q.eq("id", args.id))
      .unique();
  },
});

// For apps that have 0 or 1 active subscription per user.
export const getCurrentSubscription = query({
  args: {
    userId: v.string(),
  },
  returns: v.union(
    v.object({
      ...schema.tables.subscriptions.validator.fields,
      _id: v.id("subscriptions"),
      _creationTime: v.number(),
      product: v.object({
        ...schema.tables.products.validator.fields,
        _id: v.id("products"),
        _creationTime: v.number(),
      }),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const customer = await ctx.db
      .query("customers")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!customer) {
      return null;
    }
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("customerId_endedAt", (q) =>
        q.eq("customerId", customer.id).eq("endedAt", null)
      )
      .unique();
    if (!subscription) {
      return null;
    }
    const product = await ctx.db
      .query("products")
      .withIndex("id", (q) => q.eq("id", subscription.productId))
      .unique();
    if (!product) {
      throw new Error(`Product not found: ${subscription.productId}`);
    }
    return {
      ...subscription,
      product,
    };
  },
});

export const listUserSubscriptions = query({
  args: {
    userId: v.string(),
  },
  returns: v.array(
    v.object({
      ...schema.tables.subscriptions.validator.fields,
      _id: v.id("subscriptions"),
      _creationTime: v.number(),
      product: v.union(
        v.object({
          ...schema.tables.products.validator.fields,
          _id: v.id("products"),
          _creationTime: v.number(),
        }),
        v.null()
      ),
    })
  ),
  handler: async (ctx, args) => {
    const customer = await ctx.db
      .query("customers")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!customer) {
      return [];
    }
    const subscriptions = await asyncMap(
      ctx.db
        .query("subscriptions")
        .withIndex("customerId", (q) => q.eq("customerId", customer.id))
        .collect(),
      async (subscription) => {
        if (
          subscription.endedAt &&
          subscription.endedAt <= new Date().toISOString()
        ) {
          return;
        }
        const product = subscription.productId
          ? (await ctx.db
              .query("products")
              .withIndex("id", (q) => q.eq("id", subscription.productId))
              .unique()) || null
          : null;
        return {
          ...subscription,
          product,
        };
      }
    );
    return subscriptions.flatMap((subscription) =>
      subscription ? [subscription] : []
    );
  },
});

export const listProducts = query({
  args: {
    includeArchived: v.boolean(),
  },
  returns: v.array(
    v.object({
      ...schema.tables.products.validator.fields,
      _id: v.id("products"),
      _creationTime: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    if (args.includeArchived) {
      return ctx.db.query("products").collect();
    }
    return ctx.db
      .query("products")
      .withIndex("isArchived", (q) => q.lt("isArchived", true))
      .collect();
  },
});

export const createSubscription = mutation({
  args: {
    subscription: schema.tables.subscriptions.validator,
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("subscriptions", args.subscription);
  },
});

export const updateSubscription = mutation({
  args: {
    subscription: schema.tables.subscriptions.validator,
  },
  handler: async (ctx, args) => {
    const existingSubscription = await ctx.db
      .query("subscriptions")
      .withIndex("id", (q) => q.eq("id", args.subscription.id))
      .unique();
    if (!existingSubscription) {
      throw new Error(`Subscription not found: ${args.subscription.id}`);
    }
    await ctx.db.patch(existingSubscription._id, args.subscription);
  },
});

export const createProduct = mutation({
  args: {
    product: schema.tables.products.validator,
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("products", args.product);
  },
});

export const updateProduct = mutation({
  args: {
    product: schema.tables.products.validator,
  },
  handler: async (ctx, args) => {
    const existingProduct = await ctx.db
      .query("products")
      .withIndex("id", (q) => q.eq("id", args.product.id))
      .unique();
    if (!existingProduct) {
      throw new Error(`Product not found: ${args.product.id}`);
    }
    await ctx.db.patch(existingProduct._id, args.product);
  },
});

export const listCustomerSubscriptions = query({
  args: {
    customerId: v.string(),
  },
  returns: v.array(
    v.object({
      ...schema.tables.subscriptions.validator.fields,
      _id: v.id("subscriptions"),
      _creationTime: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    return ctx.db
      .query("subscriptions")
      .withIndex("customerId", (q) => q.eq("customerId", args.customerId))
      .collect();
  },
});
