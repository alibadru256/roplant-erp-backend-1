const { z } = require('zod');

/** Wraps a Zod schema as Express middleware — replaces scattered manual `if` checks with one
 * declarative source of truth per endpoint, so it's much harder to accidentally skip a check. */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      return res.status(400).json({ error: `${firstIssue.path.join('.')}: ${firstIssue.message}` });
    }
    req.body = result.data; // use the parsed/coerced version downstream
    next();
  };
}

const money = z.coerce.number().nonnegative();
const positiveInt = z.coerce.number().int().positive();

const saleSchema = z.object({
  customerId: positiveInt,
  items: z.array(z.object({
    productId: positiveInt,
    qty: positiveInt,
  })).min(1, 'Cart must contain at least one item.'),
  discountPct: z.coerce.number().min(0).max(100).default(0),
  paymentMethod: z.enum(['Cash', 'Card', 'Mobile Money', 'Credit']),
});

const productCreateSchema = z.object({
  sku: z.string().trim().min(1),
  partNumber: z.string().trim().optional().nullable(),
  barcode: z.string().trim().optional().nullable(),
  name: z.string().trim().min(1),
  category: z.string().trim().min(1),
  brand: z.string().trim().optional().nullable(),
  compatibility: z.string().trim().optional().nullable(),
  costPrice: money,
  sellPrice: money,
  stockQty: z.coerce.number().int().min(0).default(0),
  reorderLevel: z.coerce.number().int().min(0).default(0),
  maxStock: z.coerce.number().int().min(0).optional().nullable(),
  primarySupplierId: positiveInt.optional().nullable(),
  rack: z.string().trim().optional().nullable(),
  shelfBin: z.string().trim().optional().nullable(),
  image: z.string().optional().nullable(),
});

const productAdjustSchema = z.object({
  direction: z.enum(['Increase', 'Decrease', 'Damage']),
  qty: positiveInt,
  reason: z.string().trim().min(1, 'A reason is required for every stock adjustment.'),
});

const poCreateSchema = z.object({
  supplierId: positiveInt,
  items: z.array(z.object({
    productId: positiveInt,
    qty: positiveInt,
    unitCost: money,
  })).min(1, 'A purchase order needs at least one line item.'),
});

const poReceiveSchema = z.object({
  lines: z.array(z.object({
    poItemId: positiveInt,
    qty: z.coerce.number().int().min(0),
  })).min(1),
});

const returnSchema = z.object({
  type: z.enum(['Customer', 'Supplier']),
  productId: positiveInt,
  qty: positiveInt,
  reason: z.string().trim().min(1),
  condition: z.enum(['Resellable', 'Damaged']),
  customerId: positiveInt.optional().nullable(),
  supplierId: positiveInt.optional().nullable(),
}).refine((d) => d.type !== 'Customer' || d.customerId, { message: 'customerId is required for a customer return.', path: ['customerId'] })
  .refine((d) => d.type !== 'Supplier' || d.supplierId, { message: 'supplierId is required for a supplier return.', path: ['supplierId'] });

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your name or email.'),
  password: z.string().min(1),
});

module.exports = {
  validateBody,
  saleSchema, productCreateSchema, productAdjustSchema, poCreateSchema, poReceiveSchema, returnSchema, loginSchema,
};
