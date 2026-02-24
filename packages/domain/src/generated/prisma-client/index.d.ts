
/**
 * Client
**/

import * as runtime from './runtime/library.js';
import $Types = runtime.Types // general types
import $Public = runtime.Types.Public
import $Utils = runtime.Types.Utils
import $Extensions = runtime.Types.Extensions
import $Result = runtime.Types.Result

export type PrismaPromise<T> = $Public.PrismaPromise<T>


/**
 * Model Table
 * Physical table in the restaurant.
 */
export type Table = $Result.DefaultSelection<Prisma.$TablePayload>
/**
 * Model TimeSlot
 * A bookable time slot for the whole restaurant (not per-table).
 * maxCovers is the total seat count across all tables available in this slot.
 * reservedCovers is updated atomically when a reservation is created/cancelled.
 */
export type TimeSlot = $Result.DefaultSelection<Prisma.$TimeSlotPayload>
/**
 * Model Reservation
 * A table reservation.
 * customerId references the Medusa customer id (Twilio-verified phone → Medusa customer).
 */
export type Reservation = $Result.DefaultSelection<Prisma.$ReservationPayload>
/**
 * Model ReservationTable
 * Join table: a reservation can span multiple physical tables for large parties.
 */
export type ReservationTable = $Result.DefaultSelection<Prisma.$ReservationTablePayload>
/**
 * Model Waitlist
 * Waitlist entry when a time slot is fully booked.
 * Position is derived (ORDER BY createdAt among entries for the same slot).
 */
export type Waitlist = $Result.DefaultSelection<Prisma.$WaitlistPayload>
/**
 * Model Review
 * Product review submitted by an authenticated customer after delivery.
 * Stored here (not in Medusa) so it can be read without Medusa overhead.
 */
export type Review = $Result.DefaultSelection<Prisma.$ReviewPayload>

/**
 * Enums
 */
export namespace $Enums {
  export const TableLocation: {
  indoor: 'indoor',
  outdoor: 'outdoor',
  bar: 'bar',
  terrace: 'terrace'
};

export type TableLocation = (typeof TableLocation)[keyof typeof TableLocation]


export const ReservationStatus: {
  pending: 'pending',
  confirmed: 'confirmed',
  seated: 'seated',
  completed: 'completed',
  cancelled: 'cancelled',
  no_show: 'no_show'
};

export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus]

}

export type TableLocation = $Enums.TableLocation

export const TableLocation: typeof $Enums.TableLocation

export type ReservationStatus = $Enums.ReservationStatus

export const ReservationStatus: typeof $Enums.ReservationStatus

/**
 * ##  Prisma Client ʲˢ
 * 
 * Type-safe database client for TypeScript & Node.js
 * @example
 * ```
 * const prisma = new PrismaClient()
 * // Fetch zero or more Tables
 * const tables = await prisma.table.findMany()
 * ```
 *
 * 
 * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client).
 */
export class PrismaClient<
  ClientOptions extends Prisma.PrismaClientOptions = Prisma.PrismaClientOptions,
  U = 'log' extends keyof ClientOptions ? ClientOptions['log'] extends Array<Prisma.LogLevel | Prisma.LogDefinition> ? Prisma.GetEvents<ClientOptions['log']> : never : never,
  ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs
> {
  [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['other'] }

    /**
   * ##  Prisma Client ʲˢ
   * 
   * Type-safe database client for TypeScript & Node.js
   * @example
   * ```
   * const prisma = new PrismaClient()
   * // Fetch zero or more Tables
   * const tables = await prisma.table.findMany()
   * ```
   *
   * 
   * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client).
   */

  constructor(optionsArg ?: Prisma.Subset<ClientOptions, Prisma.PrismaClientOptions>);
  $on<V extends U>(eventType: V, callback: (event: V extends 'query' ? Prisma.QueryEvent : Prisma.LogEvent) => void): void;

  /**
   * Connect with the database
   */
  $connect(): $Utils.JsPromise<void>;

  /**
   * Disconnect from the database
   */
  $disconnect(): $Utils.JsPromise<void>;

  /**
   * Add a middleware
   * @deprecated since 4.16.0. For new code, prefer client extensions instead.
   * @see https://pris.ly/d/extensions
   */
  $use(cb: Prisma.Middleware): void

/**
   * Executes a prepared raw query and returns the number of affected rows.
   * @example
   * ```
   * const result = await prisma.$executeRaw`UPDATE User SET cool = ${true} WHERE email = ${'user@email.com'};`
   * ```
   * 
   * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client/raw-database-access).
   */
  $executeRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Prisma.PrismaPromise<number>;

  /**
   * Executes a raw query and returns the number of affected rows.
   * Susceptible to SQL injections, see documentation.
   * @example
   * ```
   * const result = await prisma.$executeRawUnsafe('UPDATE User SET cool = $1 WHERE email = $2 ;', true, 'user@email.com')
   * ```
   * 
   * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client/raw-database-access).
   */
  $executeRawUnsafe<T = unknown>(query: string, ...values: any[]): Prisma.PrismaPromise<number>;

  /**
   * Performs a prepared raw query and returns the `SELECT` data.
   * @example
   * ```
   * const result = await prisma.$queryRaw`SELECT * FROM User WHERE id = ${1} OR email = ${'user@email.com'};`
   * ```
   * 
   * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client/raw-database-access).
   */
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Prisma.PrismaPromise<T>;

  /**
   * Performs a raw query and returns the `SELECT` data.
   * Susceptible to SQL injections, see documentation.
   * @example
   * ```
   * const result = await prisma.$queryRawUnsafe('SELECT * FROM User WHERE id = $1 OR email = $2;', 1, 'user@email.com')
   * ```
   * 
   * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client/raw-database-access).
   */
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Prisma.PrismaPromise<T>;


  /**
   * Allows the running of a sequence of read/write operations that are guaranteed to either succeed or fail as a whole.
   * @example
   * ```
   * const [george, bob, alice] = await prisma.$transaction([
   *   prisma.user.create({ data: { name: 'George' } }),
   *   prisma.user.create({ data: { name: 'Bob' } }),
   *   prisma.user.create({ data: { name: 'Alice' } }),
   * ])
   * ```
   * 
   * Read more in our [docs](https://www.prisma.io/docs/concepts/components/prisma-client/transactions).
   */
  $transaction<P extends Prisma.PrismaPromise<any>[]>(arg: [...P], options?: { isolationLevel?: Prisma.TransactionIsolationLevel }): $Utils.JsPromise<runtime.Types.Utils.UnwrapTuple<P>>

  $transaction<R>(fn: (prisma: Omit<PrismaClient, runtime.ITXClientDenyList>) => $Utils.JsPromise<R>, options?: { maxWait?: number, timeout?: number, isolationLevel?: Prisma.TransactionIsolationLevel }): $Utils.JsPromise<R>


  $extends: $Extensions.ExtendsHook<"extends", Prisma.TypeMapCb, ExtArgs>

      /**
   * `prisma.table`: Exposes CRUD operations for the **Table** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more Tables
    * const tables = await prisma.table.findMany()
    * ```
    */
  get table(): Prisma.TableDelegate<ExtArgs>;

  /**
   * `prisma.timeSlot`: Exposes CRUD operations for the **TimeSlot** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more TimeSlots
    * const timeSlots = await prisma.timeSlot.findMany()
    * ```
    */
  get timeSlot(): Prisma.TimeSlotDelegate<ExtArgs>;

  /**
   * `prisma.reservation`: Exposes CRUD operations for the **Reservation** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more Reservations
    * const reservations = await prisma.reservation.findMany()
    * ```
    */
  get reservation(): Prisma.ReservationDelegate<ExtArgs>;

  /**
   * `prisma.reservationTable`: Exposes CRUD operations for the **ReservationTable** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more ReservationTables
    * const reservationTables = await prisma.reservationTable.findMany()
    * ```
    */
  get reservationTable(): Prisma.ReservationTableDelegate<ExtArgs>;

  /**
   * `prisma.waitlist`: Exposes CRUD operations for the **Waitlist** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more Waitlists
    * const waitlists = await prisma.waitlist.findMany()
    * ```
    */
  get waitlist(): Prisma.WaitlistDelegate<ExtArgs>;

  /**
   * `prisma.review`: Exposes CRUD operations for the **Review** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more Reviews
    * const reviews = await prisma.review.findMany()
    * ```
    */
  get review(): Prisma.ReviewDelegate<ExtArgs>;
}

export namespace Prisma {
  export import DMMF = runtime.DMMF

  export type PrismaPromise<T> = $Public.PrismaPromise<T>

  /**
   * Validator
   */
  export import validator = runtime.Public.validator

  /**
   * Prisma Errors
   */
  export import PrismaClientKnownRequestError = runtime.PrismaClientKnownRequestError
  export import PrismaClientUnknownRequestError = runtime.PrismaClientUnknownRequestError
  export import PrismaClientRustPanicError = runtime.PrismaClientRustPanicError
  export import PrismaClientInitializationError = runtime.PrismaClientInitializationError
  export import PrismaClientValidationError = runtime.PrismaClientValidationError
  export import NotFoundError = runtime.NotFoundError

  /**
   * Re-export of sql-template-tag
   */
  export import sql = runtime.sqltag
  export import empty = runtime.empty
  export import join = runtime.join
  export import raw = runtime.raw
  export import Sql = runtime.Sql



  /**
   * Decimal.js
   */
  export import Decimal = runtime.Decimal

  export type DecimalJsLike = runtime.DecimalJsLike

  /**
   * Metrics 
   */
  export type Metrics = runtime.Metrics
  export type Metric<T> = runtime.Metric<T>
  export type MetricHistogram = runtime.MetricHistogram
  export type MetricHistogramBucket = runtime.MetricHistogramBucket

  /**
  * Extensions
  */
  export import Extension = $Extensions.UserArgs
  export import getExtensionContext = runtime.Extensions.getExtensionContext
  export import Args = $Public.Args
  export import Payload = $Public.Payload
  export import Result = $Public.Result
  export import Exact = $Public.Exact

  /**
   * Prisma Client JS version: 5.22.0
   * Query Engine version: 605197351a3c8bdd595af2d2a9bc3025bca48ea2
   */
  export type PrismaVersion = {
    client: string
  }

  export const prismaVersion: PrismaVersion 

  /**
   * Utility Types
   */


  export import JsonObject = runtime.JsonObject
  export import JsonArray = runtime.JsonArray
  export import JsonValue = runtime.JsonValue
  export import InputJsonObject = runtime.InputJsonObject
  export import InputJsonArray = runtime.InputJsonArray
  export import InputJsonValue = runtime.InputJsonValue

  /**
   * Types of the values used to represent different kinds of `null` values when working with JSON fields.
   * 
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  namespace NullTypes {
    /**
    * Type of `Prisma.DbNull`.
    * 
    * You cannot use other instances of this class. Please use the `Prisma.DbNull` value.
    * 
    * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
    */
    class DbNull {
      private DbNull: never
      private constructor()
    }

    /**
    * Type of `Prisma.JsonNull`.
    * 
    * You cannot use other instances of this class. Please use the `Prisma.JsonNull` value.
    * 
    * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
    */
    class JsonNull {
      private JsonNull: never
      private constructor()
    }

    /**
    * Type of `Prisma.AnyNull`.
    * 
    * You cannot use other instances of this class. Please use the `Prisma.AnyNull` value.
    * 
    * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
    */
    class AnyNull {
      private AnyNull: never
      private constructor()
    }
  }

  /**
   * Helper for filtering JSON entries that have `null` on the database (empty on the db)
   * 
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  export const DbNull: NullTypes.DbNull

  /**
   * Helper for filtering JSON entries that have JSON `null` values (not empty on the db)
   * 
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  export const JsonNull: NullTypes.JsonNull

  /**
   * Helper for filtering JSON entries that are `Prisma.DbNull` or `Prisma.JsonNull`
   * 
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  export const AnyNull: NullTypes.AnyNull

  type SelectAndInclude = {
    select: any
    include: any
  }

  type SelectAndOmit = {
    select: any
    omit: any
  }

  /**
   * Get the type of the value, that the Promise holds.
   */
  export type PromiseType<T extends PromiseLike<any>> = T extends PromiseLike<infer U> ? U : T;

  /**
   * Get the return type of a function which returns a Promise.
   */
  export type PromiseReturnType<T extends (...args: any) => $Utils.JsPromise<any>> = PromiseType<ReturnType<T>>

  /**
   * From T, pick a set of properties whose keys are in the union K
   */
  type Prisma__Pick<T, K extends keyof T> = {
      [P in K]: T[P];
  };


  export type Enumerable<T> = T | Array<T>;

  export type RequiredKeys<T> = {
    [K in keyof T]-?: {} extends Prisma__Pick<T, K> ? never : K
  }[keyof T]

  export type TruthyKeys<T> = keyof {
    [K in keyof T as T[K] extends false | undefined | null ? never : K]: K
  }

  export type TrueKeys<T> = TruthyKeys<Prisma__Pick<T, RequiredKeys<T>>>

  /**
   * Subset
   * @desc From `T` pick properties that exist in `U`. Simple version of Intersection
   */
  export type Subset<T, U> = {
    [key in keyof T]: key extends keyof U ? T[key] : never;
  };

  /**
   * SelectSubset
   * @desc From `T` pick properties that exist in `U`. Simple version of Intersection.
   * Additionally, it validates, if both select and include are present. If the case, it errors.
   */
  export type SelectSubset<T, U> = {
    [key in keyof T]: key extends keyof U ? T[key] : never
  } &
    (T extends SelectAndInclude
      ? 'Please either choose `select` or `include`.'
      : T extends SelectAndOmit
        ? 'Please either choose `select` or `omit`.'
        : {})

  /**
   * Subset + Intersection
   * @desc From `T` pick properties that exist in `U` and intersect `K`
   */
  export type SubsetIntersection<T, U, K> = {
    [key in keyof T]: key extends keyof U ? T[key] : never
  } &
    K

  type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };

  /**
   * XOR is needed to have a real mutually exclusive union type
   * https://stackoverflow.com/questions/42123407/does-typescript-support-mutually-exclusive-types
   */
  type XOR<T, U> =
    T extends object ?
    U extends object ?
      (Without<T, U> & U) | (Without<U, T> & T)
    : U : T


  /**
   * Is T a Record?
   */
  type IsObject<T extends any> = T extends Array<any>
  ? False
  : T extends Date
  ? False
  : T extends Uint8Array
  ? False
  : T extends BigInt
  ? False
  : T extends object
  ? True
  : False


  /**
   * If it's T[], return T
   */
  export type UnEnumerate<T extends unknown> = T extends Array<infer U> ? U : T

  /**
   * From ts-toolbelt
   */

  type __Either<O extends object, K extends Key> = Omit<O, K> &
    {
      // Merge all but K
      [P in K]: Prisma__Pick<O, P & keyof O> // With K possibilities
    }[K]

  type EitherStrict<O extends object, K extends Key> = Strict<__Either<O, K>>

  type EitherLoose<O extends object, K extends Key> = ComputeRaw<__Either<O, K>>

  type _Either<
    O extends object,
    K extends Key,
    strict extends Boolean
  > = {
    1: EitherStrict<O, K>
    0: EitherLoose<O, K>
  }[strict]

  type Either<
    O extends object,
    K extends Key,
    strict extends Boolean = 1
  > = O extends unknown ? _Either<O, K, strict> : never

  export type Union = any

  type PatchUndefined<O extends object, O1 extends object> = {
    [K in keyof O]: O[K] extends undefined ? At<O1, K> : O[K]
  } & {}

  /** Helper Types for "Merge" **/
  export type IntersectOf<U extends Union> = (
    U extends unknown ? (k: U) => void : never
  ) extends (k: infer I) => void
    ? I
    : never

  export type Overwrite<O extends object, O1 extends object> = {
      [K in keyof O]: K extends keyof O1 ? O1[K] : O[K];
  } & {};

  type _Merge<U extends object> = IntersectOf<Overwrite<U, {
      [K in keyof U]-?: At<U, K>;
  }>>;

  type Key = string | number | symbol;
  type AtBasic<O extends object, K extends Key> = K extends keyof O ? O[K] : never;
  type AtStrict<O extends object, K extends Key> = O[K & keyof O];
  type AtLoose<O extends object, K extends Key> = O extends unknown ? AtStrict<O, K> : never;
  export type At<O extends object, K extends Key, strict extends Boolean = 1> = {
      1: AtStrict<O, K>;
      0: AtLoose<O, K>;
  }[strict];

  export type ComputeRaw<A extends any> = A extends Function ? A : {
    [K in keyof A]: A[K];
  } & {};

  export type OptionalFlat<O> = {
    [K in keyof O]?: O[K];
  } & {};

  type _Record<K extends keyof any, T> = {
    [P in K]: T;
  };

  // cause typescript not to expand types and preserve names
  type NoExpand<T> = T extends unknown ? T : never;

  // this type assumes the passed object is entirely optional
  type AtLeast<O extends object, K extends string> = NoExpand<
    O extends unknown
    ? | (K extends keyof O ? { [P in K]: O[P] } & O : O)
      | {[P in keyof O as P extends K ? K : never]-?: O[P]} & O
    : never>;

  type _Strict<U, _U = U> = U extends unknown ? U & OptionalFlat<_Record<Exclude<Keys<_U>, keyof U>, never>> : never;

  export type Strict<U extends object> = ComputeRaw<_Strict<U>>;
  /** End Helper Types for "Merge" **/

  export type Merge<U extends object> = ComputeRaw<_Merge<Strict<U>>>;

  /**
  A [[Boolean]]
  */
  export type Boolean = True | False

  // /**
  // 1
  // */
  export type True = 1

  /**
  0
  */
  export type False = 0

  export type Not<B extends Boolean> = {
    0: 1
    1: 0
  }[B]

  export type Extends<A1 extends any, A2 extends any> = [A1] extends [never]
    ? 0 // anything `never` is false
    : A1 extends A2
    ? 1
    : 0

  export type Has<U extends Union, U1 extends Union> = Not<
    Extends<Exclude<U1, U>, U1>
  >

  export type Or<B1 extends Boolean, B2 extends Boolean> = {
    0: {
      0: 0
      1: 1
    }
    1: {
      0: 1
      1: 1
    }
  }[B1][B2]

  export type Keys<U extends Union> = U extends unknown ? keyof U : never

  type Cast<A, B> = A extends B ? A : B;

  export const type: unique symbol;



  /**
   * Used by group by
   */

  export type GetScalarType<T, O> = O extends object ? {
    [P in keyof T]: P extends keyof O
      ? O[P]
      : never
  } : never

  type FieldPaths<
    T,
    U = Omit<T, '_avg' | '_sum' | '_count' | '_min' | '_max'>
  > = IsObject<T> extends True ? U : T

  type GetHavingFields<T> = {
    [K in keyof T]: Or<
      Or<Extends<'OR', K>, Extends<'AND', K>>,
      Extends<'NOT', K>
    > extends True
      ? // infer is only needed to not hit TS limit
        // based on the brilliant idea of Pierre-Antoine Mills
        // https://github.com/microsoft/TypeScript/issues/30188#issuecomment-478938437
        T[K] extends infer TK
        ? GetHavingFields<UnEnumerate<TK> extends object ? Merge<UnEnumerate<TK>> : never>
        : never
      : {} extends FieldPaths<T[K]>
      ? never
      : K
  }[keyof T]

  /**
   * Convert tuple to union
   */
  type _TupleToUnion<T> = T extends (infer E)[] ? E : never
  type TupleToUnion<K extends readonly any[]> = _TupleToUnion<K>
  type MaybeTupleToUnion<T> = T extends any[] ? TupleToUnion<T> : T

  /**
   * Like `Pick`, but additionally can also accept an array of keys
   */
  type PickEnumerable<T, K extends Enumerable<keyof T> | keyof T> = Prisma__Pick<T, MaybeTupleToUnion<K>>

  /**
   * Exclude all keys with underscores
   */
  type ExcludeUnderscoreKeys<T extends string> = T extends `_${string}` ? never : T


  export type FieldRef<Model, FieldType> = runtime.FieldRef<Model, FieldType>

  type FieldRefInputType<Model, FieldType> = Model extends never ? never : FieldRef<Model, FieldType>


  export const ModelName: {
    Table: 'Table',
    TimeSlot: 'TimeSlot',
    Reservation: 'Reservation',
    ReservationTable: 'ReservationTable',
    Waitlist: 'Waitlist',
    Review: 'Review'
  };

  export type ModelName = (typeof ModelName)[keyof typeof ModelName]


  export type Datasources = {
    db?: Datasource
  }

  interface TypeMapCb extends $Utils.Fn<{extArgs: $Extensions.InternalArgs, clientOptions: PrismaClientOptions }, $Utils.Record<string, any>> {
    returns: Prisma.TypeMap<this['params']['extArgs'], this['params']['clientOptions']>
  }

  export type TypeMap<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, ClientOptions = {}> = {
    meta: {
      modelProps: "table" | "timeSlot" | "reservation" | "reservationTable" | "waitlist" | "review"
      txIsolationLevel: Prisma.TransactionIsolationLevel
    }
    model: {
      Table: {
        payload: Prisma.$TablePayload<ExtArgs>
        fields: Prisma.TableFieldRefs
        operations: {
          findUnique: {
            args: Prisma.TableFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TablePayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.TableFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TablePayload>
          }
          findFirst: {
            args: Prisma.TableFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TablePayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.TableFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TablePayload>
          }
          findMany: {
            args: Prisma.TableFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TablePayload>[]
          }
          create: {
            args: Prisma.TableCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TablePayload>
          }
          createMany: {
            args: Prisma.TableCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.TableCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TablePayload>[]
          }
          delete: {
            args: Prisma.TableDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TablePayload>
          }
          update: {
            args: Prisma.TableUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TablePayload>
          }
          deleteMany: {
            args: Prisma.TableDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.TableUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          upsert: {
            args: Prisma.TableUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TablePayload>
          }
          aggregate: {
            args: Prisma.TableAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateTable>
          }
          groupBy: {
            args: Prisma.TableGroupByArgs<ExtArgs>
            result: $Utils.Optional<TableGroupByOutputType>[]
          }
          count: {
            args: Prisma.TableCountArgs<ExtArgs>
            result: $Utils.Optional<TableCountAggregateOutputType> | number
          }
        }
      }
      TimeSlot: {
        payload: Prisma.$TimeSlotPayload<ExtArgs>
        fields: Prisma.TimeSlotFieldRefs
        operations: {
          findUnique: {
            args: Prisma.TimeSlotFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TimeSlotPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.TimeSlotFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TimeSlotPayload>
          }
          findFirst: {
            args: Prisma.TimeSlotFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TimeSlotPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.TimeSlotFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TimeSlotPayload>
          }
          findMany: {
            args: Prisma.TimeSlotFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TimeSlotPayload>[]
          }
          create: {
            args: Prisma.TimeSlotCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TimeSlotPayload>
          }
          createMany: {
            args: Prisma.TimeSlotCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.TimeSlotCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TimeSlotPayload>[]
          }
          delete: {
            args: Prisma.TimeSlotDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TimeSlotPayload>
          }
          update: {
            args: Prisma.TimeSlotUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TimeSlotPayload>
          }
          deleteMany: {
            args: Prisma.TimeSlotDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.TimeSlotUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          upsert: {
            args: Prisma.TimeSlotUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$TimeSlotPayload>
          }
          aggregate: {
            args: Prisma.TimeSlotAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateTimeSlot>
          }
          groupBy: {
            args: Prisma.TimeSlotGroupByArgs<ExtArgs>
            result: $Utils.Optional<TimeSlotGroupByOutputType>[]
          }
          count: {
            args: Prisma.TimeSlotCountArgs<ExtArgs>
            result: $Utils.Optional<TimeSlotCountAggregateOutputType> | number
          }
        }
      }
      Reservation: {
        payload: Prisma.$ReservationPayload<ExtArgs>
        fields: Prisma.ReservationFieldRefs
        operations: {
          findUnique: {
            args: Prisma.ReservationFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.ReservationFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationPayload>
          }
          findFirst: {
            args: Prisma.ReservationFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.ReservationFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationPayload>
          }
          findMany: {
            args: Prisma.ReservationFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationPayload>[]
          }
          create: {
            args: Prisma.ReservationCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationPayload>
          }
          createMany: {
            args: Prisma.ReservationCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.ReservationCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationPayload>[]
          }
          delete: {
            args: Prisma.ReservationDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationPayload>
          }
          update: {
            args: Prisma.ReservationUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationPayload>
          }
          deleteMany: {
            args: Prisma.ReservationDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.ReservationUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          upsert: {
            args: Prisma.ReservationUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationPayload>
          }
          aggregate: {
            args: Prisma.ReservationAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateReservation>
          }
          groupBy: {
            args: Prisma.ReservationGroupByArgs<ExtArgs>
            result: $Utils.Optional<ReservationGroupByOutputType>[]
          }
          count: {
            args: Prisma.ReservationCountArgs<ExtArgs>
            result: $Utils.Optional<ReservationCountAggregateOutputType> | number
          }
        }
      }
      ReservationTable: {
        payload: Prisma.$ReservationTablePayload<ExtArgs>
        fields: Prisma.ReservationTableFieldRefs
        operations: {
          findUnique: {
            args: Prisma.ReservationTableFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationTablePayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.ReservationTableFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationTablePayload>
          }
          findFirst: {
            args: Prisma.ReservationTableFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationTablePayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.ReservationTableFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationTablePayload>
          }
          findMany: {
            args: Prisma.ReservationTableFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationTablePayload>[]
          }
          create: {
            args: Prisma.ReservationTableCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationTablePayload>
          }
          createMany: {
            args: Prisma.ReservationTableCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.ReservationTableCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationTablePayload>[]
          }
          delete: {
            args: Prisma.ReservationTableDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationTablePayload>
          }
          update: {
            args: Prisma.ReservationTableUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationTablePayload>
          }
          deleteMany: {
            args: Prisma.ReservationTableDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.ReservationTableUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          upsert: {
            args: Prisma.ReservationTableUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReservationTablePayload>
          }
          aggregate: {
            args: Prisma.ReservationTableAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateReservationTable>
          }
          groupBy: {
            args: Prisma.ReservationTableGroupByArgs<ExtArgs>
            result: $Utils.Optional<ReservationTableGroupByOutputType>[]
          }
          count: {
            args: Prisma.ReservationTableCountArgs<ExtArgs>
            result: $Utils.Optional<ReservationTableCountAggregateOutputType> | number
          }
        }
      }
      Waitlist: {
        payload: Prisma.$WaitlistPayload<ExtArgs>
        fields: Prisma.WaitlistFieldRefs
        operations: {
          findUnique: {
            args: Prisma.WaitlistFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$WaitlistPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.WaitlistFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$WaitlistPayload>
          }
          findFirst: {
            args: Prisma.WaitlistFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$WaitlistPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.WaitlistFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$WaitlistPayload>
          }
          findMany: {
            args: Prisma.WaitlistFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$WaitlistPayload>[]
          }
          create: {
            args: Prisma.WaitlistCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$WaitlistPayload>
          }
          createMany: {
            args: Prisma.WaitlistCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.WaitlistCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$WaitlistPayload>[]
          }
          delete: {
            args: Prisma.WaitlistDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$WaitlistPayload>
          }
          update: {
            args: Prisma.WaitlistUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$WaitlistPayload>
          }
          deleteMany: {
            args: Prisma.WaitlistDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.WaitlistUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          upsert: {
            args: Prisma.WaitlistUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$WaitlistPayload>
          }
          aggregate: {
            args: Prisma.WaitlistAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateWaitlist>
          }
          groupBy: {
            args: Prisma.WaitlistGroupByArgs<ExtArgs>
            result: $Utils.Optional<WaitlistGroupByOutputType>[]
          }
          count: {
            args: Prisma.WaitlistCountArgs<ExtArgs>
            result: $Utils.Optional<WaitlistCountAggregateOutputType> | number
          }
        }
      }
      Review: {
        payload: Prisma.$ReviewPayload<ExtArgs>
        fields: Prisma.ReviewFieldRefs
        operations: {
          findUnique: {
            args: Prisma.ReviewFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReviewPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.ReviewFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReviewPayload>
          }
          findFirst: {
            args: Prisma.ReviewFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReviewPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.ReviewFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReviewPayload>
          }
          findMany: {
            args: Prisma.ReviewFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReviewPayload>[]
          }
          create: {
            args: Prisma.ReviewCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReviewPayload>
          }
          createMany: {
            args: Prisma.ReviewCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.ReviewCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReviewPayload>[]
          }
          delete: {
            args: Prisma.ReviewDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReviewPayload>
          }
          update: {
            args: Prisma.ReviewUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReviewPayload>
          }
          deleteMany: {
            args: Prisma.ReviewDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.ReviewUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          upsert: {
            args: Prisma.ReviewUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ReviewPayload>
          }
          aggregate: {
            args: Prisma.ReviewAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateReview>
          }
          groupBy: {
            args: Prisma.ReviewGroupByArgs<ExtArgs>
            result: $Utils.Optional<ReviewGroupByOutputType>[]
          }
          count: {
            args: Prisma.ReviewCountArgs<ExtArgs>
            result: $Utils.Optional<ReviewCountAggregateOutputType> | number
          }
        }
      }
    }
  } & {
    other: {
      payload: any
      operations: {
        $executeRaw: {
          args: [query: TemplateStringsArray | Prisma.Sql, ...values: any[]],
          result: any
        }
        $executeRawUnsafe: {
          args: [query: string, ...values: any[]],
          result: any
        }
        $queryRaw: {
          args: [query: TemplateStringsArray | Prisma.Sql, ...values: any[]],
          result: any
        }
        $queryRawUnsafe: {
          args: [query: string, ...values: any[]],
          result: any
        }
      }
    }
  }
  export const defineExtension: $Extensions.ExtendsHook<"define", Prisma.TypeMapCb, $Extensions.DefaultArgs>
  export type DefaultPrismaClient = PrismaClient
  export type ErrorFormat = 'pretty' | 'colorless' | 'minimal'
  export interface PrismaClientOptions {
    /**
     * Overwrites the datasource url from your schema.prisma file
     */
    datasources?: Datasources
    /**
     * Overwrites the datasource url from your schema.prisma file
     */
    datasourceUrl?: string
    /**
     * @default "colorless"
     */
    errorFormat?: ErrorFormat
    /**
     * @example
     * ```
     * // Defaults to stdout
     * log: ['query', 'info', 'warn', 'error']
     * 
     * // Emit as events
     * log: [
     *   { emit: 'stdout', level: 'query' },
     *   { emit: 'stdout', level: 'info' },
     *   { emit: 'stdout', level: 'warn' }
     *   { emit: 'stdout', level: 'error' }
     * ]
     * ```
     * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client/logging#the-log-option).
     */
    log?: (LogLevel | LogDefinition)[]
    /**
     * The default values for transactionOptions
     * maxWait ?= 2000
     * timeout ?= 5000
     */
    transactionOptions?: {
      maxWait?: number
      timeout?: number
      isolationLevel?: Prisma.TransactionIsolationLevel
    }
  }


  /* Types for Logging */
  export type LogLevel = 'info' | 'query' | 'warn' | 'error'
  export type LogDefinition = {
    level: LogLevel
    emit: 'stdout' | 'event'
  }

  export type GetLogType<T extends LogLevel | LogDefinition> = T extends LogDefinition ? T['emit'] extends 'event' ? T['level'] : never : never
  export type GetEvents<T extends any> = T extends Array<LogLevel | LogDefinition> ?
    GetLogType<T[0]> | GetLogType<T[1]> | GetLogType<T[2]> | GetLogType<T[3]>
    : never

  export type QueryEvent = {
    timestamp: Date
    query: string
    params: string
    duration: number
    target: string
  }

  export type LogEvent = {
    timestamp: Date
    message: string
    target: string
  }
  /* End Types for Logging */


  export type PrismaAction =
    | 'findUnique'
    | 'findUniqueOrThrow'
    | 'findMany'
    | 'findFirst'
    | 'findFirstOrThrow'
    | 'create'
    | 'createMany'
    | 'createManyAndReturn'
    | 'update'
    | 'updateMany'
    | 'upsert'
    | 'delete'
    | 'deleteMany'
    | 'executeRaw'
    | 'queryRaw'
    | 'aggregate'
    | 'count'
    | 'runCommandRaw'
    | 'findRaw'
    | 'groupBy'

  /**
   * These options are being passed into the middleware as "params"
   */
  export type MiddlewareParams = {
    model?: ModelName
    action: PrismaAction
    args: any
    dataPath: string[]
    runInTransaction: boolean
  }

  /**
   * The `T` type makes sure, that the `return proceed` is not forgotten in the middleware implementation
   */
  export type Middleware<T = any> = (
    params: MiddlewareParams,
    next: (params: MiddlewareParams) => $Utils.JsPromise<T>,
  ) => $Utils.JsPromise<T>

  // tested in getLogLevel.test.ts
  export function getLogLevel(log: Array<LogLevel | LogDefinition>): LogLevel | undefined;

  /**
   * `PrismaClient` proxy available in interactive transactions.
   */
  export type TransactionClient = Omit<Prisma.DefaultPrismaClient, runtime.ITXClientDenyList>

  export type Datasource = {
    url?: string
  }

  /**
   * Count Types
   */


  /**
   * Count Type TableCountOutputType
   */

  export type TableCountOutputType = {
    reservationTables: number
  }

  export type TableCountOutputTypeSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    reservationTables?: boolean | TableCountOutputTypeCountReservationTablesArgs
  }

  // Custom InputTypes
  /**
   * TableCountOutputType without action
   */
  export type TableCountOutputTypeDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TableCountOutputType
     */
    select?: TableCountOutputTypeSelect<ExtArgs> | null
  }

  /**
   * TableCountOutputType without action
   */
  export type TableCountOutputTypeCountReservationTablesArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: ReservationTableWhereInput
  }


  /**
   * Count Type TimeSlotCountOutputType
   */

  export type TimeSlotCountOutputType = {
    reservations: number
    waitlist: number
  }

  export type TimeSlotCountOutputTypeSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    reservations?: boolean | TimeSlotCountOutputTypeCountReservationsArgs
    waitlist?: boolean | TimeSlotCountOutputTypeCountWaitlistArgs
  }

  // Custom InputTypes
  /**
   * TimeSlotCountOutputType without action
   */
  export type TimeSlotCountOutputTypeDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlotCountOutputType
     */
    select?: TimeSlotCountOutputTypeSelect<ExtArgs> | null
  }

  /**
   * TimeSlotCountOutputType without action
   */
  export type TimeSlotCountOutputTypeCountReservationsArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: ReservationWhereInput
  }

  /**
   * TimeSlotCountOutputType without action
   */
  export type TimeSlotCountOutputTypeCountWaitlistArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: WaitlistWhereInput
  }


  /**
   * Count Type ReservationCountOutputType
   */

  export type ReservationCountOutputType = {
    tables: number
  }

  export type ReservationCountOutputTypeSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    tables?: boolean | ReservationCountOutputTypeCountTablesArgs
  }

  // Custom InputTypes
  /**
   * ReservationCountOutputType without action
   */
  export type ReservationCountOutputTypeDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationCountOutputType
     */
    select?: ReservationCountOutputTypeSelect<ExtArgs> | null
  }

  /**
   * ReservationCountOutputType without action
   */
  export type ReservationCountOutputTypeCountTablesArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: ReservationTableWhereInput
  }


  /**
   * Models
   */

  /**
   * Model Table
   */

  export type AggregateTable = {
    _count: TableCountAggregateOutputType | null
    _avg: TableAvgAggregateOutputType | null
    _sum: TableSumAggregateOutputType | null
    _min: TableMinAggregateOutputType | null
    _max: TableMaxAggregateOutputType | null
  }

  export type TableAvgAggregateOutputType = {
    capacity: number | null
  }

  export type TableSumAggregateOutputType = {
    capacity: number | null
  }

  export type TableMinAggregateOutputType = {
    id: string | null
    number: string | null
    capacity: number | null
    location: $Enums.TableLocation | null
    accessible: boolean | null
    active: boolean | null
    createdAt: Date | null
  }

  export type TableMaxAggregateOutputType = {
    id: string | null
    number: string | null
    capacity: number | null
    location: $Enums.TableLocation | null
    accessible: boolean | null
    active: boolean | null
    createdAt: Date | null
  }

  export type TableCountAggregateOutputType = {
    id: number
    number: number
    capacity: number
    location: number
    accessible: number
    active: number
    createdAt: number
    _all: number
  }


  export type TableAvgAggregateInputType = {
    capacity?: true
  }

  export type TableSumAggregateInputType = {
    capacity?: true
  }

  export type TableMinAggregateInputType = {
    id?: true
    number?: true
    capacity?: true
    location?: true
    accessible?: true
    active?: true
    createdAt?: true
  }

  export type TableMaxAggregateInputType = {
    id?: true
    number?: true
    capacity?: true
    location?: true
    accessible?: true
    active?: true
    createdAt?: true
  }

  export type TableCountAggregateInputType = {
    id?: true
    number?: true
    capacity?: true
    location?: true
    accessible?: true
    active?: true
    createdAt?: true
    _all?: true
  }

  export type TableAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which Table to aggregate.
     */
    where?: TableWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Tables to fetch.
     */
    orderBy?: TableOrderByWithRelationInput | TableOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: TableWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Tables from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Tables.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned Tables
    **/
    _count?: true | TableCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: TableAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: TableSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: TableMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: TableMaxAggregateInputType
  }

  export type GetTableAggregateType<T extends TableAggregateArgs> = {
        [P in keyof T & keyof AggregateTable]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateTable[P]>
      : GetScalarType<T[P], AggregateTable[P]>
  }




  export type TableGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: TableWhereInput
    orderBy?: TableOrderByWithAggregationInput | TableOrderByWithAggregationInput[]
    by: TableScalarFieldEnum[] | TableScalarFieldEnum
    having?: TableScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: TableCountAggregateInputType | true
    _avg?: TableAvgAggregateInputType
    _sum?: TableSumAggregateInputType
    _min?: TableMinAggregateInputType
    _max?: TableMaxAggregateInputType
  }

  export type TableGroupByOutputType = {
    id: string
    number: string
    capacity: number
    location: $Enums.TableLocation
    accessible: boolean
    active: boolean
    createdAt: Date
    _count: TableCountAggregateOutputType | null
    _avg: TableAvgAggregateOutputType | null
    _sum: TableSumAggregateOutputType | null
    _min: TableMinAggregateOutputType | null
    _max: TableMaxAggregateOutputType | null
  }

  type GetTableGroupByPayload<T extends TableGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<TableGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof TableGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], TableGroupByOutputType[P]>
            : GetScalarType<T[P], TableGroupByOutputType[P]>
        }
      >
    >


  export type TableSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    number?: boolean
    capacity?: boolean
    location?: boolean
    accessible?: boolean
    active?: boolean
    createdAt?: boolean
    reservationTables?: boolean | Table$reservationTablesArgs<ExtArgs>
    _count?: boolean | TableCountOutputTypeDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["table"]>

  export type TableSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    number?: boolean
    capacity?: boolean
    location?: boolean
    accessible?: boolean
    active?: boolean
    createdAt?: boolean
  }, ExtArgs["result"]["table"]>

  export type TableSelectScalar = {
    id?: boolean
    number?: boolean
    capacity?: boolean
    location?: boolean
    accessible?: boolean
    active?: boolean
    createdAt?: boolean
  }

  export type TableInclude<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    reservationTables?: boolean | Table$reservationTablesArgs<ExtArgs>
    _count?: boolean | TableCountOutputTypeDefaultArgs<ExtArgs>
  }
  export type TableIncludeCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {}

  export type $TablePayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "Table"
    objects: {
      reservationTables: Prisma.$ReservationTablePayload<ExtArgs>[]
    }
    scalars: $Extensions.GetPayloadResult<{
      id: string
      number: string
      capacity: number
      location: $Enums.TableLocation
      accessible: boolean
      active: boolean
      createdAt: Date
    }, ExtArgs["result"]["table"]>
    composites: {}
  }

  type TableGetPayload<S extends boolean | null | undefined | TableDefaultArgs> = $Result.GetResult<Prisma.$TablePayload, S>

  type TableCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = 
    Omit<TableFindManyArgs, 'select' | 'include' | 'distinct'> & {
      select?: TableCountAggregateInputType | true
    }

  export interface TableDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['Table'], meta: { name: 'Table' } }
    /**
     * Find zero or one Table that matches the filter.
     * @param {TableFindUniqueArgs} args - Arguments to find a Table
     * @example
     * // Get one Table
     * const table = await prisma.table.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends TableFindUniqueArgs>(args: SelectSubset<T, TableFindUniqueArgs<ExtArgs>>): Prisma__TableClient<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "findUnique"> | null, null, ExtArgs>

    /**
     * Find one Table that matches the filter or throw an error with `error.code='P2025'` 
     * if no matches were found.
     * @param {TableFindUniqueOrThrowArgs} args - Arguments to find a Table
     * @example
     * // Get one Table
     * const table = await prisma.table.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends TableFindUniqueOrThrowArgs>(args: SelectSubset<T, TableFindUniqueOrThrowArgs<ExtArgs>>): Prisma__TableClient<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "findUniqueOrThrow">, never, ExtArgs>

    /**
     * Find the first Table that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TableFindFirstArgs} args - Arguments to find a Table
     * @example
     * // Get one Table
     * const table = await prisma.table.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends TableFindFirstArgs>(args?: SelectSubset<T, TableFindFirstArgs<ExtArgs>>): Prisma__TableClient<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "findFirst"> | null, null, ExtArgs>

    /**
     * Find the first Table that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TableFindFirstOrThrowArgs} args - Arguments to find a Table
     * @example
     * // Get one Table
     * const table = await prisma.table.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends TableFindFirstOrThrowArgs>(args?: SelectSubset<T, TableFindFirstOrThrowArgs<ExtArgs>>): Prisma__TableClient<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "findFirstOrThrow">, never, ExtArgs>

    /**
     * Find zero or more Tables that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TableFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all Tables
     * const tables = await prisma.table.findMany()
     * 
     * // Get first 10 Tables
     * const tables = await prisma.table.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const tableWithIdOnly = await prisma.table.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends TableFindManyArgs>(args?: SelectSubset<T, TableFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "findMany">>

    /**
     * Create a Table.
     * @param {TableCreateArgs} args - Arguments to create a Table.
     * @example
     * // Create one Table
     * const Table = await prisma.table.create({
     *   data: {
     *     // ... data to create a Table
     *   }
     * })
     * 
     */
    create<T extends TableCreateArgs>(args: SelectSubset<T, TableCreateArgs<ExtArgs>>): Prisma__TableClient<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "create">, never, ExtArgs>

    /**
     * Create many Tables.
     * @param {TableCreateManyArgs} args - Arguments to create many Tables.
     * @example
     * // Create many Tables
     * const table = await prisma.table.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends TableCreateManyArgs>(args?: SelectSubset<T, TableCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many Tables and returns the data saved in the database.
     * @param {TableCreateManyAndReturnArgs} args - Arguments to create many Tables.
     * @example
     * // Create many Tables
     * const table = await prisma.table.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many Tables and only return the `id`
     * const tableWithIdOnly = await prisma.table.createManyAndReturn({ 
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends TableCreateManyAndReturnArgs>(args?: SelectSubset<T, TableCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "createManyAndReturn">>

    /**
     * Delete a Table.
     * @param {TableDeleteArgs} args - Arguments to delete one Table.
     * @example
     * // Delete one Table
     * const Table = await prisma.table.delete({
     *   where: {
     *     // ... filter to delete one Table
     *   }
     * })
     * 
     */
    delete<T extends TableDeleteArgs>(args: SelectSubset<T, TableDeleteArgs<ExtArgs>>): Prisma__TableClient<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "delete">, never, ExtArgs>

    /**
     * Update one Table.
     * @param {TableUpdateArgs} args - Arguments to update one Table.
     * @example
     * // Update one Table
     * const table = await prisma.table.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends TableUpdateArgs>(args: SelectSubset<T, TableUpdateArgs<ExtArgs>>): Prisma__TableClient<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "update">, never, ExtArgs>

    /**
     * Delete zero or more Tables.
     * @param {TableDeleteManyArgs} args - Arguments to filter Tables to delete.
     * @example
     * // Delete a few Tables
     * const { count } = await prisma.table.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends TableDeleteManyArgs>(args?: SelectSubset<T, TableDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more Tables.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TableUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many Tables
     * const table = await prisma.table.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends TableUpdateManyArgs>(args: SelectSubset<T, TableUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create or update one Table.
     * @param {TableUpsertArgs} args - Arguments to update or create a Table.
     * @example
     * // Update or create a Table
     * const table = await prisma.table.upsert({
     *   create: {
     *     // ... data to create a Table
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the Table we want to update
     *   }
     * })
     */
    upsert<T extends TableUpsertArgs>(args: SelectSubset<T, TableUpsertArgs<ExtArgs>>): Prisma__TableClient<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "upsert">, never, ExtArgs>


    /**
     * Count the number of Tables.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TableCountArgs} args - Arguments to filter Tables to count.
     * @example
     * // Count the number of Tables
     * const count = await prisma.table.count({
     *   where: {
     *     // ... the filter for the Tables we want to count
     *   }
     * })
    **/
    count<T extends TableCountArgs>(
      args?: Subset<T, TableCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], TableCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a Table.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TableAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends TableAggregateArgs>(args: Subset<T, TableAggregateArgs>): Prisma.PrismaPromise<GetTableAggregateType<T>>

    /**
     * Group by Table.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TableGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends TableGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: TableGroupByArgs['orderBy'] }
        : { orderBy?: TableGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, TableGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetTableGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the Table model
   */
  readonly fields: TableFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for Table.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__TableClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    reservationTables<T extends Table$reservationTablesArgs<ExtArgs> = {}>(args?: Subset<T, Table$reservationTablesArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "findMany"> | Null>
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the Table model
   */ 
  interface TableFieldRefs {
    readonly id: FieldRef<"Table", 'String'>
    readonly number: FieldRef<"Table", 'String'>
    readonly capacity: FieldRef<"Table", 'Int'>
    readonly location: FieldRef<"Table", 'TableLocation'>
    readonly accessible: FieldRef<"Table", 'Boolean'>
    readonly active: FieldRef<"Table", 'Boolean'>
    readonly createdAt: FieldRef<"Table", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * Table findUnique
   */
  export type TableFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TableInclude<ExtArgs> | null
    /**
     * Filter, which Table to fetch.
     */
    where: TableWhereUniqueInput
  }

  /**
   * Table findUniqueOrThrow
   */
  export type TableFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TableInclude<ExtArgs> | null
    /**
     * Filter, which Table to fetch.
     */
    where: TableWhereUniqueInput
  }

  /**
   * Table findFirst
   */
  export type TableFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TableInclude<ExtArgs> | null
    /**
     * Filter, which Table to fetch.
     */
    where?: TableWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Tables to fetch.
     */
    orderBy?: TableOrderByWithRelationInput | TableOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for Tables.
     */
    cursor?: TableWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Tables from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Tables.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of Tables.
     */
    distinct?: TableScalarFieldEnum | TableScalarFieldEnum[]
  }

  /**
   * Table findFirstOrThrow
   */
  export type TableFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TableInclude<ExtArgs> | null
    /**
     * Filter, which Table to fetch.
     */
    where?: TableWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Tables to fetch.
     */
    orderBy?: TableOrderByWithRelationInput | TableOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for Tables.
     */
    cursor?: TableWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Tables from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Tables.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of Tables.
     */
    distinct?: TableScalarFieldEnum | TableScalarFieldEnum[]
  }

  /**
   * Table findMany
   */
  export type TableFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TableInclude<ExtArgs> | null
    /**
     * Filter, which Tables to fetch.
     */
    where?: TableWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Tables to fetch.
     */
    orderBy?: TableOrderByWithRelationInput | TableOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing Tables.
     */
    cursor?: TableWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Tables from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Tables.
     */
    skip?: number
    distinct?: TableScalarFieldEnum | TableScalarFieldEnum[]
  }

  /**
   * Table create
   */
  export type TableCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TableInclude<ExtArgs> | null
    /**
     * The data needed to create a Table.
     */
    data: XOR<TableCreateInput, TableUncheckedCreateInput>
  }

  /**
   * Table createMany
   */
  export type TableCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many Tables.
     */
    data: TableCreateManyInput | TableCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * Table createManyAndReturn
   */
  export type TableCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * The data used to create many Tables.
     */
    data: TableCreateManyInput | TableCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * Table update
   */
  export type TableUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TableInclude<ExtArgs> | null
    /**
     * The data needed to update a Table.
     */
    data: XOR<TableUpdateInput, TableUncheckedUpdateInput>
    /**
     * Choose, which Table to update.
     */
    where: TableWhereUniqueInput
  }

  /**
   * Table updateMany
   */
  export type TableUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update Tables.
     */
    data: XOR<TableUpdateManyMutationInput, TableUncheckedUpdateManyInput>
    /**
     * Filter which Tables to update
     */
    where?: TableWhereInput
  }

  /**
   * Table upsert
   */
  export type TableUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TableInclude<ExtArgs> | null
    /**
     * The filter to search for the Table to update in case it exists.
     */
    where: TableWhereUniqueInput
    /**
     * In case the Table found by the `where` argument doesn't exist, create a new Table with this data.
     */
    create: XOR<TableCreateInput, TableUncheckedCreateInput>
    /**
     * In case the Table was found with the provided `where` argument, update it with this data.
     */
    update: XOR<TableUpdateInput, TableUncheckedUpdateInput>
  }

  /**
   * Table delete
   */
  export type TableDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TableInclude<ExtArgs> | null
    /**
     * Filter which Table to delete.
     */
    where: TableWhereUniqueInput
  }

  /**
   * Table deleteMany
   */
  export type TableDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which Tables to delete
     */
    where?: TableWhereInput
  }

  /**
   * Table.reservationTables
   */
  export type Table$reservationTablesArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    where?: ReservationTableWhereInput
    orderBy?: ReservationTableOrderByWithRelationInput | ReservationTableOrderByWithRelationInput[]
    cursor?: ReservationTableWhereUniqueInput
    take?: number
    skip?: number
    distinct?: ReservationTableScalarFieldEnum | ReservationTableScalarFieldEnum[]
  }

  /**
   * Table without action
   */
  export type TableDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Table
     */
    select?: TableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TableInclude<ExtArgs> | null
  }


  /**
   * Model TimeSlot
   */

  export type AggregateTimeSlot = {
    _count: TimeSlotCountAggregateOutputType | null
    _avg: TimeSlotAvgAggregateOutputType | null
    _sum: TimeSlotSumAggregateOutputType | null
    _min: TimeSlotMinAggregateOutputType | null
    _max: TimeSlotMaxAggregateOutputType | null
  }

  export type TimeSlotAvgAggregateOutputType = {
    durationMinutes: number | null
    maxCovers: number | null
    reservedCovers: number | null
  }

  export type TimeSlotSumAggregateOutputType = {
    durationMinutes: number | null
    maxCovers: number | null
    reservedCovers: number | null
  }

  export type TimeSlotMinAggregateOutputType = {
    id: string | null
    date: Date | null
    startTime: string | null
    durationMinutes: number | null
    maxCovers: number | null
    reservedCovers: number | null
    createdAt: Date | null
  }

  export type TimeSlotMaxAggregateOutputType = {
    id: string | null
    date: Date | null
    startTime: string | null
    durationMinutes: number | null
    maxCovers: number | null
    reservedCovers: number | null
    createdAt: Date | null
  }

  export type TimeSlotCountAggregateOutputType = {
    id: number
    date: number
    startTime: number
    durationMinutes: number
    maxCovers: number
    reservedCovers: number
    createdAt: number
    _all: number
  }


  export type TimeSlotAvgAggregateInputType = {
    durationMinutes?: true
    maxCovers?: true
    reservedCovers?: true
  }

  export type TimeSlotSumAggregateInputType = {
    durationMinutes?: true
    maxCovers?: true
    reservedCovers?: true
  }

  export type TimeSlotMinAggregateInputType = {
    id?: true
    date?: true
    startTime?: true
    durationMinutes?: true
    maxCovers?: true
    reservedCovers?: true
    createdAt?: true
  }

  export type TimeSlotMaxAggregateInputType = {
    id?: true
    date?: true
    startTime?: true
    durationMinutes?: true
    maxCovers?: true
    reservedCovers?: true
    createdAt?: true
  }

  export type TimeSlotCountAggregateInputType = {
    id?: true
    date?: true
    startTime?: true
    durationMinutes?: true
    maxCovers?: true
    reservedCovers?: true
    createdAt?: true
    _all?: true
  }

  export type TimeSlotAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which TimeSlot to aggregate.
     */
    where?: TimeSlotWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of TimeSlots to fetch.
     */
    orderBy?: TimeSlotOrderByWithRelationInput | TimeSlotOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: TimeSlotWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` TimeSlots from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` TimeSlots.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned TimeSlots
    **/
    _count?: true | TimeSlotCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: TimeSlotAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: TimeSlotSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: TimeSlotMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: TimeSlotMaxAggregateInputType
  }

  export type GetTimeSlotAggregateType<T extends TimeSlotAggregateArgs> = {
        [P in keyof T & keyof AggregateTimeSlot]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateTimeSlot[P]>
      : GetScalarType<T[P], AggregateTimeSlot[P]>
  }




  export type TimeSlotGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: TimeSlotWhereInput
    orderBy?: TimeSlotOrderByWithAggregationInput | TimeSlotOrderByWithAggregationInput[]
    by: TimeSlotScalarFieldEnum[] | TimeSlotScalarFieldEnum
    having?: TimeSlotScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: TimeSlotCountAggregateInputType | true
    _avg?: TimeSlotAvgAggregateInputType
    _sum?: TimeSlotSumAggregateInputType
    _min?: TimeSlotMinAggregateInputType
    _max?: TimeSlotMaxAggregateInputType
  }

  export type TimeSlotGroupByOutputType = {
    id: string
    date: Date
    startTime: string
    durationMinutes: number
    maxCovers: number
    reservedCovers: number
    createdAt: Date
    _count: TimeSlotCountAggregateOutputType | null
    _avg: TimeSlotAvgAggregateOutputType | null
    _sum: TimeSlotSumAggregateOutputType | null
    _min: TimeSlotMinAggregateOutputType | null
    _max: TimeSlotMaxAggregateOutputType | null
  }

  type GetTimeSlotGroupByPayload<T extends TimeSlotGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<TimeSlotGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof TimeSlotGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], TimeSlotGroupByOutputType[P]>
            : GetScalarType<T[P], TimeSlotGroupByOutputType[P]>
        }
      >
    >


  export type TimeSlotSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    date?: boolean
    startTime?: boolean
    durationMinutes?: boolean
    maxCovers?: boolean
    reservedCovers?: boolean
    createdAt?: boolean
    reservations?: boolean | TimeSlot$reservationsArgs<ExtArgs>
    waitlist?: boolean | TimeSlot$waitlistArgs<ExtArgs>
    _count?: boolean | TimeSlotCountOutputTypeDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["timeSlot"]>

  export type TimeSlotSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    date?: boolean
    startTime?: boolean
    durationMinutes?: boolean
    maxCovers?: boolean
    reservedCovers?: boolean
    createdAt?: boolean
  }, ExtArgs["result"]["timeSlot"]>

  export type TimeSlotSelectScalar = {
    id?: boolean
    date?: boolean
    startTime?: boolean
    durationMinutes?: boolean
    maxCovers?: boolean
    reservedCovers?: boolean
    createdAt?: boolean
  }

  export type TimeSlotInclude<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    reservations?: boolean | TimeSlot$reservationsArgs<ExtArgs>
    waitlist?: boolean | TimeSlot$waitlistArgs<ExtArgs>
    _count?: boolean | TimeSlotCountOutputTypeDefaultArgs<ExtArgs>
  }
  export type TimeSlotIncludeCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {}

  export type $TimeSlotPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "TimeSlot"
    objects: {
      reservations: Prisma.$ReservationPayload<ExtArgs>[]
      waitlist: Prisma.$WaitlistPayload<ExtArgs>[]
    }
    scalars: $Extensions.GetPayloadResult<{
      id: string
      date: Date
      startTime: string
      durationMinutes: number
      maxCovers: number
      reservedCovers: number
      createdAt: Date
    }, ExtArgs["result"]["timeSlot"]>
    composites: {}
  }

  type TimeSlotGetPayload<S extends boolean | null | undefined | TimeSlotDefaultArgs> = $Result.GetResult<Prisma.$TimeSlotPayload, S>

  type TimeSlotCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = 
    Omit<TimeSlotFindManyArgs, 'select' | 'include' | 'distinct'> & {
      select?: TimeSlotCountAggregateInputType | true
    }

  export interface TimeSlotDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['TimeSlot'], meta: { name: 'TimeSlot' } }
    /**
     * Find zero or one TimeSlot that matches the filter.
     * @param {TimeSlotFindUniqueArgs} args - Arguments to find a TimeSlot
     * @example
     * // Get one TimeSlot
     * const timeSlot = await prisma.timeSlot.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends TimeSlotFindUniqueArgs>(args: SelectSubset<T, TimeSlotFindUniqueArgs<ExtArgs>>): Prisma__TimeSlotClient<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "findUnique"> | null, null, ExtArgs>

    /**
     * Find one TimeSlot that matches the filter or throw an error with `error.code='P2025'` 
     * if no matches were found.
     * @param {TimeSlotFindUniqueOrThrowArgs} args - Arguments to find a TimeSlot
     * @example
     * // Get one TimeSlot
     * const timeSlot = await prisma.timeSlot.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends TimeSlotFindUniqueOrThrowArgs>(args: SelectSubset<T, TimeSlotFindUniqueOrThrowArgs<ExtArgs>>): Prisma__TimeSlotClient<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "findUniqueOrThrow">, never, ExtArgs>

    /**
     * Find the first TimeSlot that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TimeSlotFindFirstArgs} args - Arguments to find a TimeSlot
     * @example
     * // Get one TimeSlot
     * const timeSlot = await prisma.timeSlot.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends TimeSlotFindFirstArgs>(args?: SelectSubset<T, TimeSlotFindFirstArgs<ExtArgs>>): Prisma__TimeSlotClient<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "findFirst"> | null, null, ExtArgs>

    /**
     * Find the first TimeSlot that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TimeSlotFindFirstOrThrowArgs} args - Arguments to find a TimeSlot
     * @example
     * // Get one TimeSlot
     * const timeSlot = await prisma.timeSlot.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends TimeSlotFindFirstOrThrowArgs>(args?: SelectSubset<T, TimeSlotFindFirstOrThrowArgs<ExtArgs>>): Prisma__TimeSlotClient<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "findFirstOrThrow">, never, ExtArgs>

    /**
     * Find zero or more TimeSlots that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TimeSlotFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all TimeSlots
     * const timeSlots = await prisma.timeSlot.findMany()
     * 
     * // Get first 10 TimeSlots
     * const timeSlots = await prisma.timeSlot.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const timeSlotWithIdOnly = await prisma.timeSlot.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends TimeSlotFindManyArgs>(args?: SelectSubset<T, TimeSlotFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "findMany">>

    /**
     * Create a TimeSlot.
     * @param {TimeSlotCreateArgs} args - Arguments to create a TimeSlot.
     * @example
     * // Create one TimeSlot
     * const TimeSlot = await prisma.timeSlot.create({
     *   data: {
     *     // ... data to create a TimeSlot
     *   }
     * })
     * 
     */
    create<T extends TimeSlotCreateArgs>(args: SelectSubset<T, TimeSlotCreateArgs<ExtArgs>>): Prisma__TimeSlotClient<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "create">, never, ExtArgs>

    /**
     * Create many TimeSlots.
     * @param {TimeSlotCreateManyArgs} args - Arguments to create many TimeSlots.
     * @example
     * // Create many TimeSlots
     * const timeSlot = await prisma.timeSlot.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends TimeSlotCreateManyArgs>(args?: SelectSubset<T, TimeSlotCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many TimeSlots and returns the data saved in the database.
     * @param {TimeSlotCreateManyAndReturnArgs} args - Arguments to create many TimeSlots.
     * @example
     * // Create many TimeSlots
     * const timeSlot = await prisma.timeSlot.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many TimeSlots and only return the `id`
     * const timeSlotWithIdOnly = await prisma.timeSlot.createManyAndReturn({ 
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends TimeSlotCreateManyAndReturnArgs>(args?: SelectSubset<T, TimeSlotCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "createManyAndReturn">>

    /**
     * Delete a TimeSlot.
     * @param {TimeSlotDeleteArgs} args - Arguments to delete one TimeSlot.
     * @example
     * // Delete one TimeSlot
     * const TimeSlot = await prisma.timeSlot.delete({
     *   where: {
     *     // ... filter to delete one TimeSlot
     *   }
     * })
     * 
     */
    delete<T extends TimeSlotDeleteArgs>(args: SelectSubset<T, TimeSlotDeleteArgs<ExtArgs>>): Prisma__TimeSlotClient<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "delete">, never, ExtArgs>

    /**
     * Update one TimeSlot.
     * @param {TimeSlotUpdateArgs} args - Arguments to update one TimeSlot.
     * @example
     * // Update one TimeSlot
     * const timeSlot = await prisma.timeSlot.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends TimeSlotUpdateArgs>(args: SelectSubset<T, TimeSlotUpdateArgs<ExtArgs>>): Prisma__TimeSlotClient<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "update">, never, ExtArgs>

    /**
     * Delete zero or more TimeSlots.
     * @param {TimeSlotDeleteManyArgs} args - Arguments to filter TimeSlots to delete.
     * @example
     * // Delete a few TimeSlots
     * const { count } = await prisma.timeSlot.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends TimeSlotDeleteManyArgs>(args?: SelectSubset<T, TimeSlotDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more TimeSlots.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TimeSlotUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many TimeSlots
     * const timeSlot = await prisma.timeSlot.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends TimeSlotUpdateManyArgs>(args: SelectSubset<T, TimeSlotUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create or update one TimeSlot.
     * @param {TimeSlotUpsertArgs} args - Arguments to update or create a TimeSlot.
     * @example
     * // Update or create a TimeSlot
     * const timeSlot = await prisma.timeSlot.upsert({
     *   create: {
     *     // ... data to create a TimeSlot
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the TimeSlot we want to update
     *   }
     * })
     */
    upsert<T extends TimeSlotUpsertArgs>(args: SelectSubset<T, TimeSlotUpsertArgs<ExtArgs>>): Prisma__TimeSlotClient<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "upsert">, never, ExtArgs>


    /**
     * Count the number of TimeSlots.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TimeSlotCountArgs} args - Arguments to filter TimeSlots to count.
     * @example
     * // Count the number of TimeSlots
     * const count = await prisma.timeSlot.count({
     *   where: {
     *     // ... the filter for the TimeSlots we want to count
     *   }
     * })
    **/
    count<T extends TimeSlotCountArgs>(
      args?: Subset<T, TimeSlotCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], TimeSlotCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a TimeSlot.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TimeSlotAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends TimeSlotAggregateArgs>(args: Subset<T, TimeSlotAggregateArgs>): Prisma.PrismaPromise<GetTimeSlotAggregateType<T>>

    /**
     * Group by TimeSlot.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {TimeSlotGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends TimeSlotGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: TimeSlotGroupByArgs['orderBy'] }
        : { orderBy?: TimeSlotGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, TimeSlotGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetTimeSlotGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the TimeSlot model
   */
  readonly fields: TimeSlotFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for TimeSlot.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__TimeSlotClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    reservations<T extends TimeSlot$reservationsArgs<ExtArgs> = {}>(args?: Subset<T, TimeSlot$reservationsArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "findMany"> | Null>
    waitlist<T extends TimeSlot$waitlistArgs<ExtArgs> = {}>(args?: Subset<T, TimeSlot$waitlistArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "findMany"> | Null>
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the TimeSlot model
   */ 
  interface TimeSlotFieldRefs {
    readonly id: FieldRef<"TimeSlot", 'String'>
    readonly date: FieldRef<"TimeSlot", 'DateTime'>
    readonly startTime: FieldRef<"TimeSlot", 'String'>
    readonly durationMinutes: FieldRef<"TimeSlot", 'Int'>
    readonly maxCovers: FieldRef<"TimeSlot", 'Int'>
    readonly reservedCovers: FieldRef<"TimeSlot", 'Int'>
    readonly createdAt: FieldRef<"TimeSlot", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * TimeSlot findUnique
   */
  export type TimeSlotFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TimeSlotInclude<ExtArgs> | null
    /**
     * Filter, which TimeSlot to fetch.
     */
    where: TimeSlotWhereUniqueInput
  }

  /**
   * TimeSlot findUniqueOrThrow
   */
  export type TimeSlotFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TimeSlotInclude<ExtArgs> | null
    /**
     * Filter, which TimeSlot to fetch.
     */
    where: TimeSlotWhereUniqueInput
  }

  /**
   * TimeSlot findFirst
   */
  export type TimeSlotFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TimeSlotInclude<ExtArgs> | null
    /**
     * Filter, which TimeSlot to fetch.
     */
    where?: TimeSlotWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of TimeSlots to fetch.
     */
    orderBy?: TimeSlotOrderByWithRelationInput | TimeSlotOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for TimeSlots.
     */
    cursor?: TimeSlotWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` TimeSlots from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` TimeSlots.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of TimeSlots.
     */
    distinct?: TimeSlotScalarFieldEnum | TimeSlotScalarFieldEnum[]
  }

  /**
   * TimeSlot findFirstOrThrow
   */
  export type TimeSlotFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TimeSlotInclude<ExtArgs> | null
    /**
     * Filter, which TimeSlot to fetch.
     */
    where?: TimeSlotWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of TimeSlots to fetch.
     */
    orderBy?: TimeSlotOrderByWithRelationInput | TimeSlotOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for TimeSlots.
     */
    cursor?: TimeSlotWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` TimeSlots from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` TimeSlots.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of TimeSlots.
     */
    distinct?: TimeSlotScalarFieldEnum | TimeSlotScalarFieldEnum[]
  }

  /**
   * TimeSlot findMany
   */
  export type TimeSlotFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TimeSlotInclude<ExtArgs> | null
    /**
     * Filter, which TimeSlots to fetch.
     */
    where?: TimeSlotWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of TimeSlots to fetch.
     */
    orderBy?: TimeSlotOrderByWithRelationInput | TimeSlotOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing TimeSlots.
     */
    cursor?: TimeSlotWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` TimeSlots from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` TimeSlots.
     */
    skip?: number
    distinct?: TimeSlotScalarFieldEnum | TimeSlotScalarFieldEnum[]
  }

  /**
   * TimeSlot create
   */
  export type TimeSlotCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TimeSlotInclude<ExtArgs> | null
    /**
     * The data needed to create a TimeSlot.
     */
    data: XOR<TimeSlotCreateInput, TimeSlotUncheckedCreateInput>
  }

  /**
   * TimeSlot createMany
   */
  export type TimeSlotCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many TimeSlots.
     */
    data: TimeSlotCreateManyInput | TimeSlotCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * TimeSlot createManyAndReturn
   */
  export type TimeSlotCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * The data used to create many TimeSlots.
     */
    data: TimeSlotCreateManyInput | TimeSlotCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * TimeSlot update
   */
  export type TimeSlotUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TimeSlotInclude<ExtArgs> | null
    /**
     * The data needed to update a TimeSlot.
     */
    data: XOR<TimeSlotUpdateInput, TimeSlotUncheckedUpdateInput>
    /**
     * Choose, which TimeSlot to update.
     */
    where: TimeSlotWhereUniqueInput
  }

  /**
   * TimeSlot updateMany
   */
  export type TimeSlotUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update TimeSlots.
     */
    data: XOR<TimeSlotUpdateManyMutationInput, TimeSlotUncheckedUpdateManyInput>
    /**
     * Filter which TimeSlots to update
     */
    where?: TimeSlotWhereInput
  }

  /**
   * TimeSlot upsert
   */
  export type TimeSlotUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TimeSlotInclude<ExtArgs> | null
    /**
     * The filter to search for the TimeSlot to update in case it exists.
     */
    where: TimeSlotWhereUniqueInput
    /**
     * In case the TimeSlot found by the `where` argument doesn't exist, create a new TimeSlot with this data.
     */
    create: XOR<TimeSlotCreateInput, TimeSlotUncheckedCreateInput>
    /**
     * In case the TimeSlot was found with the provided `where` argument, update it with this data.
     */
    update: XOR<TimeSlotUpdateInput, TimeSlotUncheckedUpdateInput>
  }

  /**
   * TimeSlot delete
   */
  export type TimeSlotDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TimeSlotInclude<ExtArgs> | null
    /**
     * Filter which TimeSlot to delete.
     */
    where: TimeSlotWhereUniqueInput
  }

  /**
   * TimeSlot deleteMany
   */
  export type TimeSlotDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which TimeSlots to delete
     */
    where?: TimeSlotWhereInput
  }

  /**
   * TimeSlot.reservations
   */
  export type TimeSlot$reservationsArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
    where?: ReservationWhereInput
    orderBy?: ReservationOrderByWithRelationInput | ReservationOrderByWithRelationInput[]
    cursor?: ReservationWhereUniqueInput
    take?: number
    skip?: number
    distinct?: ReservationScalarFieldEnum | ReservationScalarFieldEnum[]
  }

  /**
   * TimeSlot.waitlist
   */
  export type TimeSlot$waitlistArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
    where?: WaitlistWhereInput
    orderBy?: WaitlistOrderByWithRelationInput | WaitlistOrderByWithRelationInput[]
    cursor?: WaitlistWhereUniqueInput
    take?: number
    skip?: number
    distinct?: WaitlistScalarFieldEnum | WaitlistScalarFieldEnum[]
  }

  /**
   * TimeSlot without action
   */
  export type TimeSlotDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the TimeSlot
     */
    select?: TimeSlotSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: TimeSlotInclude<ExtArgs> | null
  }


  /**
   * Model Reservation
   */

  export type AggregateReservation = {
    _count: ReservationCountAggregateOutputType | null
    _avg: ReservationAvgAggregateOutputType | null
    _sum: ReservationSumAggregateOutputType | null
    _min: ReservationMinAggregateOutputType | null
    _max: ReservationMaxAggregateOutputType | null
  }

  export type ReservationAvgAggregateOutputType = {
    partySize: number | null
  }

  export type ReservationSumAggregateOutputType = {
    partySize: number | null
  }

  export type ReservationMinAggregateOutputType = {
    id: string | null
    customerId: string | null
    partySize: number | null
    status: $Enums.ReservationStatus | null
    confirmedAt: Date | null
    checkedInAt: Date | null
    cancelledAt: Date | null
    createdAt: Date | null
    updatedAt: Date | null
    timeSlotId: string | null
  }

  export type ReservationMaxAggregateOutputType = {
    id: string | null
    customerId: string | null
    partySize: number | null
    status: $Enums.ReservationStatus | null
    confirmedAt: Date | null
    checkedInAt: Date | null
    cancelledAt: Date | null
    createdAt: Date | null
    updatedAt: Date | null
    timeSlotId: string | null
  }

  export type ReservationCountAggregateOutputType = {
    id: number
    customerId: number
    partySize: number
    status: number
    specialRequests: number
    confirmedAt: number
    checkedInAt: number
    cancelledAt: number
    createdAt: number
    updatedAt: number
    timeSlotId: number
    _all: number
  }


  export type ReservationAvgAggregateInputType = {
    partySize?: true
  }

  export type ReservationSumAggregateInputType = {
    partySize?: true
  }

  export type ReservationMinAggregateInputType = {
    id?: true
    customerId?: true
    partySize?: true
    status?: true
    confirmedAt?: true
    checkedInAt?: true
    cancelledAt?: true
    createdAt?: true
    updatedAt?: true
    timeSlotId?: true
  }

  export type ReservationMaxAggregateInputType = {
    id?: true
    customerId?: true
    partySize?: true
    status?: true
    confirmedAt?: true
    checkedInAt?: true
    cancelledAt?: true
    createdAt?: true
    updatedAt?: true
    timeSlotId?: true
  }

  export type ReservationCountAggregateInputType = {
    id?: true
    customerId?: true
    partySize?: true
    status?: true
    specialRequests?: true
    confirmedAt?: true
    checkedInAt?: true
    cancelledAt?: true
    createdAt?: true
    updatedAt?: true
    timeSlotId?: true
    _all?: true
  }

  export type ReservationAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which Reservation to aggregate.
     */
    where?: ReservationWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Reservations to fetch.
     */
    orderBy?: ReservationOrderByWithRelationInput | ReservationOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: ReservationWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Reservations from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Reservations.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned Reservations
    **/
    _count?: true | ReservationCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: ReservationAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: ReservationSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: ReservationMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: ReservationMaxAggregateInputType
  }

  export type GetReservationAggregateType<T extends ReservationAggregateArgs> = {
        [P in keyof T & keyof AggregateReservation]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateReservation[P]>
      : GetScalarType<T[P], AggregateReservation[P]>
  }




  export type ReservationGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: ReservationWhereInput
    orderBy?: ReservationOrderByWithAggregationInput | ReservationOrderByWithAggregationInput[]
    by: ReservationScalarFieldEnum[] | ReservationScalarFieldEnum
    having?: ReservationScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: ReservationCountAggregateInputType | true
    _avg?: ReservationAvgAggregateInputType
    _sum?: ReservationSumAggregateInputType
    _min?: ReservationMinAggregateInputType
    _max?: ReservationMaxAggregateInputType
  }

  export type ReservationGroupByOutputType = {
    id: string
    customerId: string
    partySize: number
    status: $Enums.ReservationStatus
    specialRequests: JsonValue
    confirmedAt: Date | null
    checkedInAt: Date | null
    cancelledAt: Date | null
    createdAt: Date
    updatedAt: Date
    timeSlotId: string
    _count: ReservationCountAggregateOutputType | null
    _avg: ReservationAvgAggregateOutputType | null
    _sum: ReservationSumAggregateOutputType | null
    _min: ReservationMinAggregateOutputType | null
    _max: ReservationMaxAggregateOutputType | null
  }

  type GetReservationGroupByPayload<T extends ReservationGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<ReservationGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof ReservationGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], ReservationGroupByOutputType[P]>
            : GetScalarType<T[P], ReservationGroupByOutputType[P]>
        }
      >
    >


  export type ReservationSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    customerId?: boolean
    partySize?: boolean
    status?: boolean
    specialRequests?: boolean
    confirmedAt?: boolean
    checkedInAt?: boolean
    cancelledAt?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    timeSlotId?: boolean
    timeSlot?: boolean | TimeSlotDefaultArgs<ExtArgs>
    tables?: boolean | Reservation$tablesArgs<ExtArgs>
    _count?: boolean | ReservationCountOutputTypeDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["reservation"]>

  export type ReservationSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    customerId?: boolean
    partySize?: boolean
    status?: boolean
    specialRequests?: boolean
    confirmedAt?: boolean
    checkedInAt?: boolean
    cancelledAt?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    timeSlotId?: boolean
    timeSlot?: boolean | TimeSlotDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["reservation"]>

  export type ReservationSelectScalar = {
    id?: boolean
    customerId?: boolean
    partySize?: boolean
    status?: boolean
    specialRequests?: boolean
    confirmedAt?: boolean
    checkedInAt?: boolean
    cancelledAt?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    timeSlotId?: boolean
  }

  export type ReservationInclude<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    timeSlot?: boolean | TimeSlotDefaultArgs<ExtArgs>
    tables?: boolean | Reservation$tablesArgs<ExtArgs>
    _count?: boolean | ReservationCountOutputTypeDefaultArgs<ExtArgs>
  }
  export type ReservationIncludeCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    timeSlot?: boolean | TimeSlotDefaultArgs<ExtArgs>
  }

  export type $ReservationPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "Reservation"
    objects: {
      timeSlot: Prisma.$TimeSlotPayload<ExtArgs>
      tables: Prisma.$ReservationTablePayload<ExtArgs>[]
    }
    scalars: $Extensions.GetPayloadResult<{
      id: string
      customerId: string
      partySize: number
      status: $Enums.ReservationStatus
      specialRequests: Prisma.JsonValue
      confirmedAt: Date | null
      checkedInAt: Date | null
      cancelledAt: Date | null
      createdAt: Date
      updatedAt: Date
      timeSlotId: string
    }, ExtArgs["result"]["reservation"]>
    composites: {}
  }

  type ReservationGetPayload<S extends boolean | null | undefined | ReservationDefaultArgs> = $Result.GetResult<Prisma.$ReservationPayload, S>

  type ReservationCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = 
    Omit<ReservationFindManyArgs, 'select' | 'include' | 'distinct'> & {
      select?: ReservationCountAggregateInputType | true
    }

  export interface ReservationDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['Reservation'], meta: { name: 'Reservation' } }
    /**
     * Find zero or one Reservation that matches the filter.
     * @param {ReservationFindUniqueArgs} args - Arguments to find a Reservation
     * @example
     * // Get one Reservation
     * const reservation = await prisma.reservation.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends ReservationFindUniqueArgs>(args: SelectSubset<T, ReservationFindUniqueArgs<ExtArgs>>): Prisma__ReservationClient<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "findUnique"> | null, null, ExtArgs>

    /**
     * Find one Reservation that matches the filter or throw an error with `error.code='P2025'` 
     * if no matches were found.
     * @param {ReservationFindUniqueOrThrowArgs} args - Arguments to find a Reservation
     * @example
     * // Get one Reservation
     * const reservation = await prisma.reservation.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends ReservationFindUniqueOrThrowArgs>(args: SelectSubset<T, ReservationFindUniqueOrThrowArgs<ExtArgs>>): Prisma__ReservationClient<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "findUniqueOrThrow">, never, ExtArgs>

    /**
     * Find the first Reservation that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationFindFirstArgs} args - Arguments to find a Reservation
     * @example
     * // Get one Reservation
     * const reservation = await prisma.reservation.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends ReservationFindFirstArgs>(args?: SelectSubset<T, ReservationFindFirstArgs<ExtArgs>>): Prisma__ReservationClient<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "findFirst"> | null, null, ExtArgs>

    /**
     * Find the first Reservation that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationFindFirstOrThrowArgs} args - Arguments to find a Reservation
     * @example
     * // Get one Reservation
     * const reservation = await prisma.reservation.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends ReservationFindFirstOrThrowArgs>(args?: SelectSubset<T, ReservationFindFirstOrThrowArgs<ExtArgs>>): Prisma__ReservationClient<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "findFirstOrThrow">, never, ExtArgs>

    /**
     * Find zero or more Reservations that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all Reservations
     * const reservations = await prisma.reservation.findMany()
     * 
     * // Get first 10 Reservations
     * const reservations = await prisma.reservation.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const reservationWithIdOnly = await prisma.reservation.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends ReservationFindManyArgs>(args?: SelectSubset<T, ReservationFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "findMany">>

    /**
     * Create a Reservation.
     * @param {ReservationCreateArgs} args - Arguments to create a Reservation.
     * @example
     * // Create one Reservation
     * const Reservation = await prisma.reservation.create({
     *   data: {
     *     // ... data to create a Reservation
     *   }
     * })
     * 
     */
    create<T extends ReservationCreateArgs>(args: SelectSubset<T, ReservationCreateArgs<ExtArgs>>): Prisma__ReservationClient<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "create">, never, ExtArgs>

    /**
     * Create many Reservations.
     * @param {ReservationCreateManyArgs} args - Arguments to create many Reservations.
     * @example
     * // Create many Reservations
     * const reservation = await prisma.reservation.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends ReservationCreateManyArgs>(args?: SelectSubset<T, ReservationCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many Reservations and returns the data saved in the database.
     * @param {ReservationCreateManyAndReturnArgs} args - Arguments to create many Reservations.
     * @example
     * // Create many Reservations
     * const reservation = await prisma.reservation.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many Reservations and only return the `id`
     * const reservationWithIdOnly = await prisma.reservation.createManyAndReturn({ 
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends ReservationCreateManyAndReturnArgs>(args?: SelectSubset<T, ReservationCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "createManyAndReturn">>

    /**
     * Delete a Reservation.
     * @param {ReservationDeleteArgs} args - Arguments to delete one Reservation.
     * @example
     * // Delete one Reservation
     * const Reservation = await prisma.reservation.delete({
     *   where: {
     *     // ... filter to delete one Reservation
     *   }
     * })
     * 
     */
    delete<T extends ReservationDeleteArgs>(args: SelectSubset<T, ReservationDeleteArgs<ExtArgs>>): Prisma__ReservationClient<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "delete">, never, ExtArgs>

    /**
     * Update one Reservation.
     * @param {ReservationUpdateArgs} args - Arguments to update one Reservation.
     * @example
     * // Update one Reservation
     * const reservation = await prisma.reservation.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends ReservationUpdateArgs>(args: SelectSubset<T, ReservationUpdateArgs<ExtArgs>>): Prisma__ReservationClient<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "update">, never, ExtArgs>

    /**
     * Delete zero or more Reservations.
     * @param {ReservationDeleteManyArgs} args - Arguments to filter Reservations to delete.
     * @example
     * // Delete a few Reservations
     * const { count } = await prisma.reservation.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends ReservationDeleteManyArgs>(args?: SelectSubset<T, ReservationDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more Reservations.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many Reservations
     * const reservation = await prisma.reservation.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends ReservationUpdateManyArgs>(args: SelectSubset<T, ReservationUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create or update one Reservation.
     * @param {ReservationUpsertArgs} args - Arguments to update or create a Reservation.
     * @example
     * // Update or create a Reservation
     * const reservation = await prisma.reservation.upsert({
     *   create: {
     *     // ... data to create a Reservation
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the Reservation we want to update
     *   }
     * })
     */
    upsert<T extends ReservationUpsertArgs>(args: SelectSubset<T, ReservationUpsertArgs<ExtArgs>>): Prisma__ReservationClient<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "upsert">, never, ExtArgs>


    /**
     * Count the number of Reservations.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationCountArgs} args - Arguments to filter Reservations to count.
     * @example
     * // Count the number of Reservations
     * const count = await prisma.reservation.count({
     *   where: {
     *     // ... the filter for the Reservations we want to count
     *   }
     * })
    **/
    count<T extends ReservationCountArgs>(
      args?: Subset<T, ReservationCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], ReservationCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a Reservation.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends ReservationAggregateArgs>(args: Subset<T, ReservationAggregateArgs>): Prisma.PrismaPromise<GetReservationAggregateType<T>>

    /**
     * Group by Reservation.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends ReservationGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: ReservationGroupByArgs['orderBy'] }
        : { orderBy?: ReservationGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, ReservationGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetReservationGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the Reservation model
   */
  readonly fields: ReservationFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for Reservation.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__ReservationClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    timeSlot<T extends TimeSlotDefaultArgs<ExtArgs> = {}>(args?: Subset<T, TimeSlotDefaultArgs<ExtArgs>>): Prisma__TimeSlotClient<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "findUniqueOrThrow"> | Null, Null, ExtArgs>
    tables<T extends Reservation$tablesArgs<ExtArgs> = {}>(args?: Subset<T, Reservation$tablesArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "findMany"> | Null>
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the Reservation model
   */ 
  interface ReservationFieldRefs {
    readonly id: FieldRef<"Reservation", 'String'>
    readonly customerId: FieldRef<"Reservation", 'String'>
    readonly partySize: FieldRef<"Reservation", 'Int'>
    readonly status: FieldRef<"Reservation", 'ReservationStatus'>
    readonly specialRequests: FieldRef<"Reservation", 'Json'>
    readonly confirmedAt: FieldRef<"Reservation", 'DateTime'>
    readonly checkedInAt: FieldRef<"Reservation", 'DateTime'>
    readonly cancelledAt: FieldRef<"Reservation", 'DateTime'>
    readonly createdAt: FieldRef<"Reservation", 'DateTime'>
    readonly updatedAt: FieldRef<"Reservation", 'DateTime'>
    readonly timeSlotId: FieldRef<"Reservation", 'String'>
  }
    

  // Custom InputTypes
  /**
   * Reservation findUnique
   */
  export type ReservationFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
    /**
     * Filter, which Reservation to fetch.
     */
    where: ReservationWhereUniqueInput
  }

  /**
   * Reservation findUniqueOrThrow
   */
  export type ReservationFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
    /**
     * Filter, which Reservation to fetch.
     */
    where: ReservationWhereUniqueInput
  }

  /**
   * Reservation findFirst
   */
  export type ReservationFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
    /**
     * Filter, which Reservation to fetch.
     */
    where?: ReservationWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Reservations to fetch.
     */
    orderBy?: ReservationOrderByWithRelationInput | ReservationOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for Reservations.
     */
    cursor?: ReservationWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Reservations from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Reservations.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of Reservations.
     */
    distinct?: ReservationScalarFieldEnum | ReservationScalarFieldEnum[]
  }

  /**
   * Reservation findFirstOrThrow
   */
  export type ReservationFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
    /**
     * Filter, which Reservation to fetch.
     */
    where?: ReservationWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Reservations to fetch.
     */
    orderBy?: ReservationOrderByWithRelationInput | ReservationOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for Reservations.
     */
    cursor?: ReservationWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Reservations from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Reservations.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of Reservations.
     */
    distinct?: ReservationScalarFieldEnum | ReservationScalarFieldEnum[]
  }

  /**
   * Reservation findMany
   */
  export type ReservationFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
    /**
     * Filter, which Reservations to fetch.
     */
    where?: ReservationWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Reservations to fetch.
     */
    orderBy?: ReservationOrderByWithRelationInput | ReservationOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing Reservations.
     */
    cursor?: ReservationWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Reservations from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Reservations.
     */
    skip?: number
    distinct?: ReservationScalarFieldEnum | ReservationScalarFieldEnum[]
  }

  /**
   * Reservation create
   */
  export type ReservationCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
    /**
     * The data needed to create a Reservation.
     */
    data: XOR<ReservationCreateInput, ReservationUncheckedCreateInput>
  }

  /**
   * Reservation createMany
   */
  export type ReservationCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many Reservations.
     */
    data: ReservationCreateManyInput | ReservationCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * Reservation createManyAndReturn
   */
  export type ReservationCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * The data used to create many Reservations.
     */
    data: ReservationCreateManyInput | ReservationCreateManyInput[]
    skipDuplicates?: boolean
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationIncludeCreateManyAndReturn<ExtArgs> | null
  }

  /**
   * Reservation update
   */
  export type ReservationUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
    /**
     * The data needed to update a Reservation.
     */
    data: XOR<ReservationUpdateInput, ReservationUncheckedUpdateInput>
    /**
     * Choose, which Reservation to update.
     */
    where: ReservationWhereUniqueInput
  }

  /**
   * Reservation updateMany
   */
  export type ReservationUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update Reservations.
     */
    data: XOR<ReservationUpdateManyMutationInput, ReservationUncheckedUpdateManyInput>
    /**
     * Filter which Reservations to update
     */
    where?: ReservationWhereInput
  }

  /**
   * Reservation upsert
   */
  export type ReservationUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
    /**
     * The filter to search for the Reservation to update in case it exists.
     */
    where: ReservationWhereUniqueInput
    /**
     * In case the Reservation found by the `where` argument doesn't exist, create a new Reservation with this data.
     */
    create: XOR<ReservationCreateInput, ReservationUncheckedCreateInput>
    /**
     * In case the Reservation was found with the provided `where` argument, update it with this data.
     */
    update: XOR<ReservationUpdateInput, ReservationUncheckedUpdateInput>
  }

  /**
   * Reservation delete
   */
  export type ReservationDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
    /**
     * Filter which Reservation to delete.
     */
    where: ReservationWhereUniqueInput
  }

  /**
   * Reservation deleteMany
   */
  export type ReservationDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which Reservations to delete
     */
    where?: ReservationWhereInput
  }

  /**
   * Reservation.tables
   */
  export type Reservation$tablesArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    where?: ReservationTableWhereInput
    orderBy?: ReservationTableOrderByWithRelationInput | ReservationTableOrderByWithRelationInput[]
    cursor?: ReservationTableWhereUniqueInput
    take?: number
    skip?: number
    distinct?: ReservationTableScalarFieldEnum | ReservationTableScalarFieldEnum[]
  }

  /**
   * Reservation without action
   */
  export type ReservationDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Reservation
     */
    select?: ReservationSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationInclude<ExtArgs> | null
  }


  /**
   * Model ReservationTable
   */

  export type AggregateReservationTable = {
    _count: ReservationTableCountAggregateOutputType | null
    _min: ReservationTableMinAggregateOutputType | null
    _max: ReservationTableMaxAggregateOutputType | null
  }

  export type ReservationTableMinAggregateOutputType = {
    reservationId: string | null
    tableId: string | null
  }

  export type ReservationTableMaxAggregateOutputType = {
    reservationId: string | null
    tableId: string | null
  }

  export type ReservationTableCountAggregateOutputType = {
    reservationId: number
    tableId: number
    _all: number
  }


  export type ReservationTableMinAggregateInputType = {
    reservationId?: true
    tableId?: true
  }

  export type ReservationTableMaxAggregateInputType = {
    reservationId?: true
    tableId?: true
  }

  export type ReservationTableCountAggregateInputType = {
    reservationId?: true
    tableId?: true
    _all?: true
  }

  export type ReservationTableAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which ReservationTable to aggregate.
     */
    where?: ReservationTableWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of ReservationTables to fetch.
     */
    orderBy?: ReservationTableOrderByWithRelationInput | ReservationTableOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: ReservationTableWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` ReservationTables from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` ReservationTables.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned ReservationTables
    **/
    _count?: true | ReservationTableCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: ReservationTableMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: ReservationTableMaxAggregateInputType
  }

  export type GetReservationTableAggregateType<T extends ReservationTableAggregateArgs> = {
        [P in keyof T & keyof AggregateReservationTable]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateReservationTable[P]>
      : GetScalarType<T[P], AggregateReservationTable[P]>
  }




  export type ReservationTableGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: ReservationTableWhereInput
    orderBy?: ReservationTableOrderByWithAggregationInput | ReservationTableOrderByWithAggregationInput[]
    by: ReservationTableScalarFieldEnum[] | ReservationTableScalarFieldEnum
    having?: ReservationTableScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: ReservationTableCountAggregateInputType | true
    _min?: ReservationTableMinAggregateInputType
    _max?: ReservationTableMaxAggregateInputType
  }

  export type ReservationTableGroupByOutputType = {
    reservationId: string
    tableId: string
    _count: ReservationTableCountAggregateOutputType | null
    _min: ReservationTableMinAggregateOutputType | null
    _max: ReservationTableMaxAggregateOutputType | null
  }

  type GetReservationTableGroupByPayload<T extends ReservationTableGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<ReservationTableGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof ReservationTableGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], ReservationTableGroupByOutputType[P]>
            : GetScalarType<T[P], ReservationTableGroupByOutputType[P]>
        }
      >
    >


  export type ReservationTableSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    reservationId?: boolean
    tableId?: boolean
    reservation?: boolean | ReservationDefaultArgs<ExtArgs>
    table?: boolean | TableDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["reservationTable"]>

  export type ReservationTableSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    reservationId?: boolean
    tableId?: boolean
    reservation?: boolean | ReservationDefaultArgs<ExtArgs>
    table?: boolean | TableDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["reservationTable"]>

  export type ReservationTableSelectScalar = {
    reservationId?: boolean
    tableId?: boolean
  }

  export type ReservationTableInclude<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    reservation?: boolean | ReservationDefaultArgs<ExtArgs>
    table?: boolean | TableDefaultArgs<ExtArgs>
  }
  export type ReservationTableIncludeCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    reservation?: boolean | ReservationDefaultArgs<ExtArgs>
    table?: boolean | TableDefaultArgs<ExtArgs>
  }

  export type $ReservationTablePayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "ReservationTable"
    objects: {
      reservation: Prisma.$ReservationPayload<ExtArgs>
      table: Prisma.$TablePayload<ExtArgs>
    }
    scalars: $Extensions.GetPayloadResult<{
      reservationId: string
      tableId: string
    }, ExtArgs["result"]["reservationTable"]>
    composites: {}
  }

  type ReservationTableGetPayload<S extends boolean | null | undefined | ReservationTableDefaultArgs> = $Result.GetResult<Prisma.$ReservationTablePayload, S>

  type ReservationTableCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = 
    Omit<ReservationTableFindManyArgs, 'select' | 'include' | 'distinct'> & {
      select?: ReservationTableCountAggregateInputType | true
    }

  export interface ReservationTableDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['ReservationTable'], meta: { name: 'ReservationTable' } }
    /**
     * Find zero or one ReservationTable that matches the filter.
     * @param {ReservationTableFindUniqueArgs} args - Arguments to find a ReservationTable
     * @example
     * // Get one ReservationTable
     * const reservationTable = await prisma.reservationTable.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends ReservationTableFindUniqueArgs>(args: SelectSubset<T, ReservationTableFindUniqueArgs<ExtArgs>>): Prisma__ReservationTableClient<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "findUnique"> | null, null, ExtArgs>

    /**
     * Find one ReservationTable that matches the filter or throw an error with `error.code='P2025'` 
     * if no matches were found.
     * @param {ReservationTableFindUniqueOrThrowArgs} args - Arguments to find a ReservationTable
     * @example
     * // Get one ReservationTable
     * const reservationTable = await prisma.reservationTable.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends ReservationTableFindUniqueOrThrowArgs>(args: SelectSubset<T, ReservationTableFindUniqueOrThrowArgs<ExtArgs>>): Prisma__ReservationTableClient<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "findUniqueOrThrow">, never, ExtArgs>

    /**
     * Find the first ReservationTable that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationTableFindFirstArgs} args - Arguments to find a ReservationTable
     * @example
     * // Get one ReservationTable
     * const reservationTable = await prisma.reservationTable.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends ReservationTableFindFirstArgs>(args?: SelectSubset<T, ReservationTableFindFirstArgs<ExtArgs>>): Prisma__ReservationTableClient<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "findFirst"> | null, null, ExtArgs>

    /**
     * Find the first ReservationTable that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationTableFindFirstOrThrowArgs} args - Arguments to find a ReservationTable
     * @example
     * // Get one ReservationTable
     * const reservationTable = await prisma.reservationTable.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends ReservationTableFindFirstOrThrowArgs>(args?: SelectSubset<T, ReservationTableFindFirstOrThrowArgs<ExtArgs>>): Prisma__ReservationTableClient<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "findFirstOrThrow">, never, ExtArgs>

    /**
     * Find zero or more ReservationTables that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationTableFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all ReservationTables
     * const reservationTables = await prisma.reservationTable.findMany()
     * 
     * // Get first 10 ReservationTables
     * const reservationTables = await prisma.reservationTable.findMany({ take: 10 })
     * 
     * // Only select the `reservationId`
     * const reservationTableWithReservationIdOnly = await prisma.reservationTable.findMany({ select: { reservationId: true } })
     * 
     */
    findMany<T extends ReservationTableFindManyArgs>(args?: SelectSubset<T, ReservationTableFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "findMany">>

    /**
     * Create a ReservationTable.
     * @param {ReservationTableCreateArgs} args - Arguments to create a ReservationTable.
     * @example
     * // Create one ReservationTable
     * const ReservationTable = await prisma.reservationTable.create({
     *   data: {
     *     // ... data to create a ReservationTable
     *   }
     * })
     * 
     */
    create<T extends ReservationTableCreateArgs>(args: SelectSubset<T, ReservationTableCreateArgs<ExtArgs>>): Prisma__ReservationTableClient<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "create">, never, ExtArgs>

    /**
     * Create many ReservationTables.
     * @param {ReservationTableCreateManyArgs} args - Arguments to create many ReservationTables.
     * @example
     * // Create many ReservationTables
     * const reservationTable = await prisma.reservationTable.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends ReservationTableCreateManyArgs>(args?: SelectSubset<T, ReservationTableCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many ReservationTables and returns the data saved in the database.
     * @param {ReservationTableCreateManyAndReturnArgs} args - Arguments to create many ReservationTables.
     * @example
     * // Create many ReservationTables
     * const reservationTable = await prisma.reservationTable.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many ReservationTables and only return the `reservationId`
     * const reservationTableWithReservationIdOnly = await prisma.reservationTable.createManyAndReturn({ 
     *   select: { reservationId: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends ReservationTableCreateManyAndReturnArgs>(args?: SelectSubset<T, ReservationTableCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "createManyAndReturn">>

    /**
     * Delete a ReservationTable.
     * @param {ReservationTableDeleteArgs} args - Arguments to delete one ReservationTable.
     * @example
     * // Delete one ReservationTable
     * const ReservationTable = await prisma.reservationTable.delete({
     *   where: {
     *     // ... filter to delete one ReservationTable
     *   }
     * })
     * 
     */
    delete<T extends ReservationTableDeleteArgs>(args: SelectSubset<T, ReservationTableDeleteArgs<ExtArgs>>): Prisma__ReservationTableClient<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "delete">, never, ExtArgs>

    /**
     * Update one ReservationTable.
     * @param {ReservationTableUpdateArgs} args - Arguments to update one ReservationTable.
     * @example
     * // Update one ReservationTable
     * const reservationTable = await prisma.reservationTable.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends ReservationTableUpdateArgs>(args: SelectSubset<T, ReservationTableUpdateArgs<ExtArgs>>): Prisma__ReservationTableClient<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "update">, never, ExtArgs>

    /**
     * Delete zero or more ReservationTables.
     * @param {ReservationTableDeleteManyArgs} args - Arguments to filter ReservationTables to delete.
     * @example
     * // Delete a few ReservationTables
     * const { count } = await prisma.reservationTable.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends ReservationTableDeleteManyArgs>(args?: SelectSubset<T, ReservationTableDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more ReservationTables.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationTableUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many ReservationTables
     * const reservationTable = await prisma.reservationTable.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends ReservationTableUpdateManyArgs>(args: SelectSubset<T, ReservationTableUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create or update one ReservationTable.
     * @param {ReservationTableUpsertArgs} args - Arguments to update or create a ReservationTable.
     * @example
     * // Update or create a ReservationTable
     * const reservationTable = await prisma.reservationTable.upsert({
     *   create: {
     *     // ... data to create a ReservationTable
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the ReservationTable we want to update
     *   }
     * })
     */
    upsert<T extends ReservationTableUpsertArgs>(args: SelectSubset<T, ReservationTableUpsertArgs<ExtArgs>>): Prisma__ReservationTableClient<$Result.GetResult<Prisma.$ReservationTablePayload<ExtArgs>, T, "upsert">, never, ExtArgs>


    /**
     * Count the number of ReservationTables.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationTableCountArgs} args - Arguments to filter ReservationTables to count.
     * @example
     * // Count the number of ReservationTables
     * const count = await prisma.reservationTable.count({
     *   where: {
     *     // ... the filter for the ReservationTables we want to count
     *   }
     * })
    **/
    count<T extends ReservationTableCountArgs>(
      args?: Subset<T, ReservationTableCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], ReservationTableCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a ReservationTable.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationTableAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends ReservationTableAggregateArgs>(args: Subset<T, ReservationTableAggregateArgs>): Prisma.PrismaPromise<GetReservationTableAggregateType<T>>

    /**
     * Group by ReservationTable.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReservationTableGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends ReservationTableGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: ReservationTableGroupByArgs['orderBy'] }
        : { orderBy?: ReservationTableGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, ReservationTableGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetReservationTableGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the ReservationTable model
   */
  readonly fields: ReservationTableFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for ReservationTable.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__ReservationTableClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    reservation<T extends ReservationDefaultArgs<ExtArgs> = {}>(args?: Subset<T, ReservationDefaultArgs<ExtArgs>>): Prisma__ReservationClient<$Result.GetResult<Prisma.$ReservationPayload<ExtArgs>, T, "findUniqueOrThrow"> | Null, Null, ExtArgs>
    table<T extends TableDefaultArgs<ExtArgs> = {}>(args?: Subset<T, TableDefaultArgs<ExtArgs>>): Prisma__TableClient<$Result.GetResult<Prisma.$TablePayload<ExtArgs>, T, "findUniqueOrThrow"> | Null, Null, ExtArgs>
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the ReservationTable model
   */ 
  interface ReservationTableFieldRefs {
    readonly reservationId: FieldRef<"ReservationTable", 'String'>
    readonly tableId: FieldRef<"ReservationTable", 'String'>
  }
    

  // Custom InputTypes
  /**
   * ReservationTable findUnique
   */
  export type ReservationTableFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    /**
     * Filter, which ReservationTable to fetch.
     */
    where: ReservationTableWhereUniqueInput
  }

  /**
   * ReservationTable findUniqueOrThrow
   */
  export type ReservationTableFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    /**
     * Filter, which ReservationTable to fetch.
     */
    where: ReservationTableWhereUniqueInput
  }

  /**
   * ReservationTable findFirst
   */
  export type ReservationTableFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    /**
     * Filter, which ReservationTable to fetch.
     */
    where?: ReservationTableWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of ReservationTables to fetch.
     */
    orderBy?: ReservationTableOrderByWithRelationInput | ReservationTableOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for ReservationTables.
     */
    cursor?: ReservationTableWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` ReservationTables from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` ReservationTables.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of ReservationTables.
     */
    distinct?: ReservationTableScalarFieldEnum | ReservationTableScalarFieldEnum[]
  }

  /**
   * ReservationTable findFirstOrThrow
   */
  export type ReservationTableFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    /**
     * Filter, which ReservationTable to fetch.
     */
    where?: ReservationTableWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of ReservationTables to fetch.
     */
    orderBy?: ReservationTableOrderByWithRelationInput | ReservationTableOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for ReservationTables.
     */
    cursor?: ReservationTableWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` ReservationTables from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` ReservationTables.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of ReservationTables.
     */
    distinct?: ReservationTableScalarFieldEnum | ReservationTableScalarFieldEnum[]
  }

  /**
   * ReservationTable findMany
   */
  export type ReservationTableFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    /**
     * Filter, which ReservationTables to fetch.
     */
    where?: ReservationTableWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of ReservationTables to fetch.
     */
    orderBy?: ReservationTableOrderByWithRelationInput | ReservationTableOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing ReservationTables.
     */
    cursor?: ReservationTableWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` ReservationTables from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` ReservationTables.
     */
    skip?: number
    distinct?: ReservationTableScalarFieldEnum | ReservationTableScalarFieldEnum[]
  }

  /**
   * ReservationTable create
   */
  export type ReservationTableCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    /**
     * The data needed to create a ReservationTable.
     */
    data: XOR<ReservationTableCreateInput, ReservationTableUncheckedCreateInput>
  }

  /**
   * ReservationTable createMany
   */
  export type ReservationTableCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many ReservationTables.
     */
    data: ReservationTableCreateManyInput | ReservationTableCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * ReservationTable createManyAndReturn
   */
  export type ReservationTableCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * The data used to create many ReservationTables.
     */
    data: ReservationTableCreateManyInput | ReservationTableCreateManyInput[]
    skipDuplicates?: boolean
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableIncludeCreateManyAndReturn<ExtArgs> | null
  }

  /**
   * ReservationTable update
   */
  export type ReservationTableUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    /**
     * The data needed to update a ReservationTable.
     */
    data: XOR<ReservationTableUpdateInput, ReservationTableUncheckedUpdateInput>
    /**
     * Choose, which ReservationTable to update.
     */
    where: ReservationTableWhereUniqueInput
  }

  /**
   * ReservationTable updateMany
   */
  export type ReservationTableUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update ReservationTables.
     */
    data: XOR<ReservationTableUpdateManyMutationInput, ReservationTableUncheckedUpdateManyInput>
    /**
     * Filter which ReservationTables to update
     */
    where?: ReservationTableWhereInput
  }

  /**
   * ReservationTable upsert
   */
  export type ReservationTableUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    /**
     * The filter to search for the ReservationTable to update in case it exists.
     */
    where: ReservationTableWhereUniqueInput
    /**
     * In case the ReservationTable found by the `where` argument doesn't exist, create a new ReservationTable with this data.
     */
    create: XOR<ReservationTableCreateInput, ReservationTableUncheckedCreateInput>
    /**
     * In case the ReservationTable was found with the provided `where` argument, update it with this data.
     */
    update: XOR<ReservationTableUpdateInput, ReservationTableUncheckedUpdateInput>
  }

  /**
   * ReservationTable delete
   */
  export type ReservationTableDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
    /**
     * Filter which ReservationTable to delete.
     */
    where: ReservationTableWhereUniqueInput
  }

  /**
   * ReservationTable deleteMany
   */
  export type ReservationTableDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which ReservationTables to delete
     */
    where?: ReservationTableWhereInput
  }

  /**
   * ReservationTable without action
   */
  export type ReservationTableDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ReservationTable
     */
    select?: ReservationTableSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: ReservationTableInclude<ExtArgs> | null
  }


  /**
   * Model Waitlist
   */

  export type AggregateWaitlist = {
    _count: WaitlistCountAggregateOutputType | null
    _avg: WaitlistAvgAggregateOutputType | null
    _sum: WaitlistSumAggregateOutputType | null
    _min: WaitlistMinAggregateOutputType | null
    _max: WaitlistMaxAggregateOutputType | null
  }

  export type WaitlistAvgAggregateOutputType = {
    partySize: number | null
  }

  export type WaitlistSumAggregateOutputType = {
    partySize: number | null
  }

  export type WaitlistMinAggregateOutputType = {
    id: string | null
    customerId: string | null
    partySize: number | null
    notifiedAt: Date | null
    expiresAt: Date | null
    createdAt: Date | null
    timeSlotId: string | null
  }

  export type WaitlistMaxAggregateOutputType = {
    id: string | null
    customerId: string | null
    partySize: number | null
    notifiedAt: Date | null
    expiresAt: Date | null
    createdAt: Date | null
    timeSlotId: string | null
  }

  export type WaitlistCountAggregateOutputType = {
    id: number
    customerId: number
    partySize: number
    notifiedAt: number
    expiresAt: number
    createdAt: number
    timeSlotId: number
    _all: number
  }


  export type WaitlistAvgAggregateInputType = {
    partySize?: true
  }

  export type WaitlistSumAggregateInputType = {
    partySize?: true
  }

  export type WaitlistMinAggregateInputType = {
    id?: true
    customerId?: true
    partySize?: true
    notifiedAt?: true
    expiresAt?: true
    createdAt?: true
    timeSlotId?: true
  }

  export type WaitlistMaxAggregateInputType = {
    id?: true
    customerId?: true
    partySize?: true
    notifiedAt?: true
    expiresAt?: true
    createdAt?: true
    timeSlotId?: true
  }

  export type WaitlistCountAggregateInputType = {
    id?: true
    customerId?: true
    partySize?: true
    notifiedAt?: true
    expiresAt?: true
    createdAt?: true
    timeSlotId?: true
    _all?: true
  }

  export type WaitlistAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which Waitlist to aggregate.
     */
    where?: WaitlistWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Waitlists to fetch.
     */
    orderBy?: WaitlistOrderByWithRelationInput | WaitlistOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: WaitlistWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Waitlists from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Waitlists.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned Waitlists
    **/
    _count?: true | WaitlistCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: WaitlistAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: WaitlistSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: WaitlistMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: WaitlistMaxAggregateInputType
  }

  export type GetWaitlistAggregateType<T extends WaitlistAggregateArgs> = {
        [P in keyof T & keyof AggregateWaitlist]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateWaitlist[P]>
      : GetScalarType<T[P], AggregateWaitlist[P]>
  }




  export type WaitlistGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: WaitlistWhereInput
    orderBy?: WaitlistOrderByWithAggregationInput | WaitlistOrderByWithAggregationInput[]
    by: WaitlistScalarFieldEnum[] | WaitlistScalarFieldEnum
    having?: WaitlistScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: WaitlistCountAggregateInputType | true
    _avg?: WaitlistAvgAggregateInputType
    _sum?: WaitlistSumAggregateInputType
    _min?: WaitlistMinAggregateInputType
    _max?: WaitlistMaxAggregateInputType
  }

  export type WaitlistGroupByOutputType = {
    id: string
    customerId: string
    partySize: number
    notifiedAt: Date | null
    expiresAt: Date
    createdAt: Date
    timeSlotId: string
    _count: WaitlistCountAggregateOutputType | null
    _avg: WaitlistAvgAggregateOutputType | null
    _sum: WaitlistSumAggregateOutputType | null
    _min: WaitlistMinAggregateOutputType | null
    _max: WaitlistMaxAggregateOutputType | null
  }

  type GetWaitlistGroupByPayload<T extends WaitlistGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<WaitlistGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof WaitlistGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], WaitlistGroupByOutputType[P]>
            : GetScalarType<T[P], WaitlistGroupByOutputType[P]>
        }
      >
    >


  export type WaitlistSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    customerId?: boolean
    partySize?: boolean
    notifiedAt?: boolean
    expiresAt?: boolean
    createdAt?: boolean
    timeSlotId?: boolean
    timeSlot?: boolean | TimeSlotDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["waitlist"]>

  export type WaitlistSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    customerId?: boolean
    partySize?: boolean
    notifiedAt?: boolean
    expiresAt?: boolean
    createdAt?: boolean
    timeSlotId?: boolean
    timeSlot?: boolean | TimeSlotDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["waitlist"]>

  export type WaitlistSelectScalar = {
    id?: boolean
    customerId?: boolean
    partySize?: boolean
    notifiedAt?: boolean
    expiresAt?: boolean
    createdAt?: boolean
    timeSlotId?: boolean
  }

  export type WaitlistInclude<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    timeSlot?: boolean | TimeSlotDefaultArgs<ExtArgs>
  }
  export type WaitlistIncludeCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    timeSlot?: boolean | TimeSlotDefaultArgs<ExtArgs>
  }

  export type $WaitlistPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "Waitlist"
    objects: {
      timeSlot: Prisma.$TimeSlotPayload<ExtArgs>
    }
    scalars: $Extensions.GetPayloadResult<{
      id: string
      customerId: string
      partySize: number
      notifiedAt: Date | null
      expiresAt: Date
      createdAt: Date
      timeSlotId: string
    }, ExtArgs["result"]["waitlist"]>
    composites: {}
  }

  type WaitlistGetPayload<S extends boolean | null | undefined | WaitlistDefaultArgs> = $Result.GetResult<Prisma.$WaitlistPayload, S>

  type WaitlistCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = 
    Omit<WaitlistFindManyArgs, 'select' | 'include' | 'distinct'> & {
      select?: WaitlistCountAggregateInputType | true
    }

  export interface WaitlistDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['Waitlist'], meta: { name: 'Waitlist' } }
    /**
     * Find zero or one Waitlist that matches the filter.
     * @param {WaitlistFindUniqueArgs} args - Arguments to find a Waitlist
     * @example
     * // Get one Waitlist
     * const waitlist = await prisma.waitlist.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends WaitlistFindUniqueArgs>(args: SelectSubset<T, WaitlistFindUniqueArgs<ExtArgs>>): Prisma__WaitlistClient<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "findUnique"> | null, null, ExtArgs>

    /**
     * Find one Waitlist that matches the filter or throw an error with `error.code='P2025'` 
     * if no matches were found.
     * @param {WaitlistFindUniqueOrThrowArgs} args - Arguments to find a Waitlist
     * @example
     * // Get one Waitlist
     * const waitlist = await prisma.waitlist.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends WaitlistFindUniqueOrThrowArgs>(args: SelectSubset<T, WaitlistFindUniqueOrThrowArgs<ExtArgs>>): Prisma__WaitlistClient<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "findUniqueOrThrow">, never, ExtArgs>

    /**
     * Find the first Waitlist that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {WaitlistFindFirstArgs} args - Arguments to find a Waitlist
     * @example
     * // Get one Waitlist
     * const waitlist = await prisma.waitlist.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends WaitlistFindFirstArgs>(args?: SelectSubset<T, WaitlistFindFirstArgs<ExtArgs>>): Prisma__WaitlistClient<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "findFirst"> | null, null, ExtArgs>

    /**
     * Find the first Waitlist that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {WaitlistFindFirstOrThrowArgs} args - Arguments to find a Waitlist
     * @example
     * // Get one Waitlist
     * const waitlist = await prisma.waitlist.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends WaitlistFindFirstOrThrowArgs>(args?: SelectSubset<T, WaitlistFindFirstOrThrowArgs<ExtArgs>>): Prisma__WaitlistClient<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "findFirstOrThrow">, never, ExtArgs>

    /**
     * Find zero or more Waitlists that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {WaitlistFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all Waitlists
     * const waitlists = await prisma.waitlist.findMany()
     * 
     * // Get first 10 Waitlists
     * const waitlists = await prisma.waitlist.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const waitlistWithIdOnly = await prisma.waitlist.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends WaitlistFindManyArgs>(args?: SelectSubset<T, WaitlistFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "findMany">>

    /**
     * Create a Waitlist.
     * @param {WaitlistCreateArgs} args - Arguments to create a Waitlist.
     * @example
     * // Create one Waitlist
     * const Waitlist = await prisma.waitlist.create({
     *   data: {
     *     // ... data to create a Waitlist
     *   }
     * })
     * 
     */
    create<T extends WaitlistCreateArgs>(args: SelectSubset<T, WaitlistCreateArgs<ExtArgs>>): Prisma__WaitlistClient<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "create">, never, ExtArgs>

    /**
     * Create many Waitlists.
     * @param {WaitlistCreateManyArgs} args - Arguments to create many Waitlists.
     * @example
     * // Create many Waitlists
     * const waitlist = await prisma.waitlist.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends WaitlistCreateManyArgs>(args?: SelectSubset<T, WaitlistCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many Waitlists and returns the data saved in the database.
     * @param {WaitlistCreateManyAndReturnArgs} args - Arguments to create many Waitlists.
     * @example
     * // Create many Waitlists
     * const waitlist = await prisma.waitlist.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many Waitlists and only return the `id`
     * const waitlistWithIdOnly = await prisma.waitlist.createManyAndReturn({ 
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends WaitlistCreateManyAndReturnArgs>(args?: SelectSubset<T, WaitlistCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "createManyAndReturn">>

    /**
     * Delete a Waitlist.
     * @param {WaitlistDeleteArgs} args - Arguments to delete one Waitlist.
     * @example
     * // Delete one Waitlist
     * const Waitlist = await prisma.waitlist.delete({
     *   where: {
     *     // ... filter to delete one Waitlist
     *   }
     * })
     * 
     */
    delete<T extends WaitlistDeleteArgs>(args: SelectSubset<T, WaitlistDeleteArgs<ExtArgs>>): Prisma__WaitlistClient<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "delete">, never, ExtArgs>

    /**
     * Update one Waitlist.
     * @param {WaitlistUpdateArgs} args - Arguments to update one Waitlist.
     * @example
     * // Update one Waitlist
     * const waitlist = await prisma.waitlist.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends WaitlistUpdateArgs>(args: SelectSubset<T, WaitlistUpdateArgs<ExtArgs>>): Prisma__WaitlistClient<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "update">, never, ExtArgs>

    /**
     * Delete zero or more Waitlists.
     * @param {WaitlistDeleteManyArgs} args - Arguments to filter Waitlists to delete.
     * @example
     * // Delete a few Waitlists
     * const { count } = await prisma.waitlist.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends WaitlistDeleteManyArgs>(args?: SelectSubset<T, WaitlistDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more Waitlists.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {WaitlistUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many Waitlists
     * const waitlist = await prisma.waitlist.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends WaitlistUpdateManyArgs>(args: SelectSubset<T, WaitlistUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create or update one Waitlist.
     * @param {WaitlistUpsertArgs} args - Arguments to update or create a Waitlist.
     * @example
     * // Update or create a Waitlist
     * const waitlist = await prisma.waitlist.upsert({
     *   create: {
     *     // ... data to create a Waitlist
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the Waitlist we want to update
     *   }
     * })
     */
    upsert<T extends WaitlistUpsertArgs>(args: SelectSubset<T, WaitlistUpsertArgs<ExtArgs>>): Prisma__WaitlistClient<$Result.GetResult<Prisma.$WaitlistPayload<ExtArgs>, T, "upsert">, never, ExtArgs>


    /**
     * Count the number of Waitlists.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {WaitlistCountArgs} args - Arguments to filter Waitlists to count.
     * @example
     * // Count the number of Waitlists
     * const count = await prisma.waitlist.count({
     *   where: {
     *     // ... the filter for the Waitlists we want to count
     *   }
     * })
    **/
    count<T extends WaitlistCountArgs>(
      args?: Subset<T, WaitlistCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], WaitlistCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a Waitlist.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {WaitlistAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends WaitlistAggregateArgs>(args: Subset<T, WaitlistAggregateArgs>): Prisma.PrismaPromise<GetWaitlistAggregateType<T>>

    /**
     * Group by Waitlist.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {WaitlistGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends WaitlistGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: WaitlistGroupByArgs['orderBy'] }
        : { orderBy?: WaitlistGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, WaitlistGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetWaitlistGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the Waitlist model
   */
  readonly fields: WaitlistFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for Waitlist.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__WaitlistClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    timeSlot<T extends TimeSlotDefaultArgs<ExtArgs> = {}>(args?: Subset<T, TimeSlotDefaultArgs<ExtArgs>>): Prisma__TimeSlotClient<$Result.GetResult<Prisma.$TimeSlotPayload<ExtArgs>, T, "findUniqueOrThrow"> | Null, Null, ExtArgs>
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the Waitlist model
   */ 
  interface WaitlistFieldRefs {
    readonly id: FieldRef<"Waitlist", 'String'>
    readonly customerId: FieldRef<"Waitlist", 'String'>
    readonly partySize: FieldRef<"Waitlist", 'Int'>
    readonly notifiedAt: FieldRef<"Waitlist", 'DateTime'>
    readonly expiresAt: FieldRef<"Waitlist", 'DateTime'>
    readonly createdAt: FieldRef<"Waitlist", 'DateTime'>
    readonly timeSlotId: FieldRef<"Waitlist", 'String'>
  }
    

  // Custom InputTypes
  /**
   * Waitlist findUnique
   */
  export type WaitlistFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
    /**
     * Filter, which Waitlist to fetch.
     */
    where: WaitlistWhereUniqueInput
  }

  /**
   * Waitlist findUniqueOrThrow
   */
  export type WaitlistFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
    /**
     * Filter, which Waitlist to fetch.
     */
    where: WaitlistWhereUniqueInput
  }

  /**
   * Waitlist findFirst
   */
  export type WaitlistFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
    /**
     * Filter, which Waitlist to fetch.
     */
    where?: WaitlistWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Waitlists to fetch.
     */
    orderBy?: WaitlistOrderByWithRelationInput | WaitlistOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for Waitlists.
     */
    cursor?: WaitlistWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Waitlists from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Waitlists.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of Waitlists.
     */
    distinct?: WaitlistScalarFieldEnum | WaitlistScalarFieldEnum[]
  }

  /**
   * Waitlist findFirstOrThrow
   */
  export type WaitlistFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
    /**
     * Filter, which Waitlist to fetch.
     */
    where?: WaitlistWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Waitlists to fetch.
     */
    orderBy?: WaitlistOrderByWithRelationInput | WaitlistOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for Waitlists.
     */
    cursor?: WaitlistWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Waitlists from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Waitlists.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of Waitlists.
     */
    distinct?: WaitlistScalarFieldEnum | WaitlistScalarFieldEnum[]
  }

  /**
   * Waitlist findMany
   */
  export type WaitlistFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
    /**
     * Filter, which Waitlists to fetch.
     */
    where?: WaitlistWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Waitlists to fetch.
     */
    orderBy?: WaitlistOrderByWithRelationInput | WaitlistOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing Waitlists.
     */
    cursor?: WaitlistWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Waitlists from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Waitlists.
     */
    skip?: number
    distinct?: WaitlistScalarFieldEnum | WaitlistScalarFieldEnum[]
  }

  /**
   * Waitlist create
   */
  export type WaitlistCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
    /**
     * The data needed to create a Waitlist.
     */
    data: XOR<WaitlistCreateInput, WaitlistUncheckedCreateInput>
  }

  /**
   * Waitlist createMany
   */
  export type WaitlistCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many Waitlists.
     */
    data: WaitlistCreateManyInput | WaitlistCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * Waitlist createManyAndReturn
   */
  export type WaitlistCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * The data used to create many Waitlists.
     */
    data: WaitlistCreateManyInput | WaitlistCreateManyInput[]
    skipDuplicates?: boolean
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistIncludeCreateManyAndReturn<ExtArgs> | null
  }

  /**
   * Waitlist update
   */
  export type WaitlistUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
    /**
     * The data needed to update a Waitlist.
     */
    data: XOR<WaitlistUpdateInput, WaitlistUncheckedUpdateInput>
    /**
     * Choose, which Waitlist to update.
     */
    where: WaitlistWhereUniqueInput
  }

  /**
   * Waitlist updateMany
   */
  export type WaitlistUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update Waitlists.
     */
    data: XOR<WaitlistUpdateManyMutationInput, WaitlistUncheckedUpdateManyInput>
    /**
     * Filter which Waitlists to update
     */
    where?: WaitlistWhereInput
  }

  /**
   * Waitlist upsert
   */
  export type WaitlistUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
    /**
     * The filter to search for the Waitlist to update in case it exists.
     */
    where: WaitlistWhereUniqueInput
    /**
     * In case the Waitlist found by the `where` argument doesn't exist, create a new Waitlist with this data.
     */
    create: XOR<WaitlistCreateInput, WaitlistUncheckedCreateInput>
    /**
     * In case the Waitlist was found with the provided `where` argument, update it with this data.
     */
    update: XOR<WaitlistUpdateInput, WaitlistUncheckedUpdateInput>
  }

  /**
   * Waitlist delete
   */
  export type WaitlistDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
    /**
     * Filter which Waitlist to delete.
     */
    where: WaitlistWhereUniqueInput
  }

  /**
   * Waitlist deleteMany
   */
  export type WaitlistDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which Waitlists to delete
     */
    where?: WaitlistWhereInput
  }

  /**
   * Waitlist without action
   */
  export type WaitlistDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Waitlist
     */
    select?: WaitlistSelect<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: WaitlistInclude<ExtArgs> | null
  }


  /**
   * Model Review
   */

  export type AggregateReview = {
    _count: ReviewCountAggregateOutputType | null
    _avg: ReviewAvgAggregateOutputType | null
    _sum: ReviewSumAggregateOutputType | null
    _min: ReviewMinAggregateOutputType | null
    _max: ReviewMaxAggregateOutputType | null
  }

  export type ReviewAvgAggregateOutputType = {
    rating: number | null
  }

  export type ReviewSumAggregateOutputType = {
    rating: number | null
  }

  export type ReviewMinAggregateOutputType = {
    id: string | null
    orderId: string | null
    customerId: string | null
    rating: number | null
    comment: string | null
    channel: string | null
    createdAt: Date | null
  }

  export type ReviewMaxAggregateOutputType = {
    id: string | null
    orderId: string | null
    customerId: string | null
    rating: number | null
    comment: string | null
    channel: string | null
    createdAt: Date | null
  }

  export type ReviewCountAggregateOutputType = {
    id: number
    orderId: number
    productIds: number
    customerId: number
    rating: number
    comment: number
    channel: number
    createdAt: number
    _all: number
  }


  export type ReviewAvgAggregateInputType = {
    rating?: true
  }

  export type ReviewSumAggregateInputType = {
    rating?: true
  }

  export type ReviewMinAggregateInputType = {
    id?: true
    orderId?: true
    customerId?: true
    rating?: true
    comment?: true
    channel?: true
    createdAt?: true
  }

  export type ReviewMaxAggregateInputType = {
    id?: true
    orderId?: true
    customerId?: true
    rating?: true
    comment?: true
    channel?: true
    createdAt?: true
  }

  export type ReviewCountAggregateInputType = {
    id?: true
    orderId?: true
    productIds?: true
    customerId?: true
    rating?: true
    comment?: true
    channel?: true
    createdAt?: true
    _all?: true
  }

  export type ReviewAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which Review to aggregate.
     */
    where?: ReviewWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Reviews to fetch.
     */
    orderBy?: ReviewOrderByWithRelationInput | ReviewOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: ReviewWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Reviews from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Reviews.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned Reviews
    **/
    _count?: true | ReviewCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: ReviewAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: ReviewSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: ReviewMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: ReviewMaxAggregateInputType
  }

  export type GetReviewAggregateType<T extends ReviewAggregateArgs> = {
        [P in keyof T & keyof AggregateReview]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateReview[P]>
      : GetScalarType<T[P], AggregateReview[P]>
  }




  export type ReviewGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: ReviewWhereInput
    orderBy?: ReviewOrderByWithAggregationInput | ReviewOrderByWithAggregationInput[]
    by: ReviewScalarFieldEnum[] | ReviewScalarFieldEnum
    having?: ReviewScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: ReviewCountAggregateInputType | true
    _avg?: ReviewAvgAggregateInputType
    _sum?: ReviewSumAggregateInputType
    _min?: ReviewMinAggregateInputType
    _max?: ReviewMaxAggregateInputType
  }

  export type ReviewGroupByOutputType = {
    id: string
    orderId: string
    productIds: string[]
    customerId: string
    rating: number
    comment: string | null
    channel: string
    createdAt: Date
    _count: ReviewCountAggregateOutputType | null
    _avg: ReviewAvgAggregateOutputType | null
    _sum: ReviewSumAggregateOutputType | null
    _min: ReviewMinAggregateOutputType | null
    _max: ReviewMaxAggregateOutputType | null
  }

  type GetReviewGroupByPayload<T extends ReviewGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<ReviewGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof ReviewGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], ReviewGroupByOutputType[P]>
            : GetScalarType<T[P], ReviewGroupByOutputType[P]>
        }
      >
    >


  export type ReviewSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    orderId?: boolean
    productIds?: boolean
    customerId?: boolean
    rating?: boolean
    comment?: boolean
    channel?: boolean
    createdAt?: boolean
  }, ExtArgs["result"]["review"]>

  export type ReviewSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    orderId?: boolean
    productIds?: boolean
    customerId?: boolean
    rating?: boolean
    comment?: boolean
    channel?: boolean
    createdAt?: boolean
  }, ExtArgs["result"]["review"]>

  export type ReviewSelectScalar = {
    id?: boolean
    orderId?: boolean
    productIds?: boolean
    customerId?: boolean
    rating?: boolean
    comment?: boolean
    channel?: boolean
    createdAt?: boolean
  }


  export type $ReviewPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "Review"
    objects: {}
    scalars: $Extensions.GetPayloadResult<{
      id: string
      orderId: string
      productIds: string[]
      customerId: string
      rating: number
      comment: string | null
      channel: string
      createdAt: Date
    }, ExtArgs["result"]["review"]>
    composites: {}
  }

  type ReviewGetPayload<S extends boolean | null | undefined | ReviewDefaultArgs> = $Result.GetResult<Prisma.$ReviewPayload, S>

  type ReviewCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = 
    Omit<ReviewFindManyArgs, 'select' | 'include' | 'distinct'> & {
      select?: ReviewCountAggregateInputType | true
    }

  export interface ReviewDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['Review'], meta: { name: 'Review' } }
    /**
     * Find zero or one Review that matches the filter.
     * @param {ReviewFindUniqueArgs} args - Arguments to find a Review
     * @example
     * // Get one Review
     * const review = await prisma.review.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends ReviewFindUniqueArgs>(args: SelectSubset<T, ReviewFindUniqueArgs<ExtArgs>>): Prisma__ReviewClient<$Result.GetResult<Prisma.$ReviewPayload<ExtArgs>, T, "findUnique"> | null, null, ExtArgs>

    /**
     * Find one Review that matches the filter or throw an error with `error.code='P2025'` 
     * if no matches were found.
     * @param {ReviewFindUniqueOrThrowArgs} args - Arguments to find a Review
     * @example
     * // Get one Review
     * const review = await prisma.review.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends ReviewFindUniqueOrThrowArgs>(args: SelectSubset<T, ReviewFindUniqueOrThrowArgs<ExtArgs>>): Prisma__ReviewClient<$Result.GetResult<Prisma.$ReviewPayload<ExtArgs>, T, "findUniqueOrThrow">, never, ExtArgs>

    /**
     * Find the first Review that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReviewFindFirstArgs} args - Arguments to find a Review
     * @example
     * // Get one Review
     * const review = await prisma.review.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends ReviewFindFirstArgs>(args?: SelectSubset<T, ReviewFindFirstArgs<ExtArgs>>): Prisma__ReviewClient<$Result.GetResult<Prisma.$ReviewPayload<ExtArgs>, T, "findFirst"> | null, null, ExtArgs>

    /**
     * Find the first Review that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReviewFindFirstOrThrowArgs} args - Arguments to find a Review
     * @example
     * // Get one Review
     * const review = await prisma.review.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends ReviewFindFirstOrThrowArgs>(args?: SelectSubset<T, ReviewFindFirstOrThrowArgs<ExtArgs>>): Prisma__ReviewClient<$Result.GetResult<Prisma.$ReviewPayload<ExtArgs>, T, "findFirstOrThrow">, never, ExtArgs>

    /**
     * Find zero or more Reviews that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReviewFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all Reviews
     * const reviews = await prisma.review.findMany()
     * 
     * // Get first 10 Reviews
     * const reviews = await prisma.review.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const reviewWithIdOnly = await prisma.review.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends ReviewFindManyArgs>(args?: SelectSubset<T, ReviewFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ReviewPayload<ExtArgs>, T, "findMany">>

    /**
     * Create a Review.
     * @param {ReviewCreateArgs} args - Arguments to create a Review.
     * @example
     * // Create one Review
     * const Review = await prisma.review.create({
     *   data: {
     *     // ... data to create a Review
     *   }
     * })
     * 
     */
    create<T extends ReviewCreateArgs>(args: SelectSubset<T, ReviewCreateArgs<ExtArgs>>): Prisma__ReviewClient<$Result.GetResult<Prisma.$ReviewPayload<ExtArgs>, T, "create">, never, ExtArgs>

    /**
     * Create many Reviews.
     * @param {ReviewCreateManyArgs} args - Arguments to create many Reviews.
     * @example
     * // Create many Reviews
     * const review = await prisma.review.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends ReviewCreateManyArgs>(args?: SelectSubset<T, ReviewCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many Reviews and returns the data saved in the database.
     * @param {ReviewCreateManyAndReturnArgs} args - Arguments to create many Reviews.
     * @example
     * // Create many Reviews
     * const review = await prisma.review.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many Reviews and only return the `id`
     * const reviewWithIdOnly = await prisma.review.createManyAndReturn({ 
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends ReviewCreateManyAndReturnArgs>(args?: SelectSubset<T, ReviewCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ReviewPayload<ExtArgs>, T, "createManyAndReturn">>

    /**
     * Delete a Review.
     * @param {ReviewDeleteArgs} args - Arguments to delete one Review.
     * @example
     * // Delete one Review
     * const Review = await prisma.review.delete({
     *   where: {
     *     // ... filter to delete one Review
     *   }
     * })
     * 
     */
    delete<T extends ReviewDeleteArgs>(args: SelectSubset<T, ReviewDeleteArgs<ExtArgs>>): Prisma__ReviewClient<$Result.GetResult<Prisma.$ReviewPayload<ExtArgs>, T, "delete">, never, ExtArgs>

    /**
     * Update one Review.
     * @param {ReviewUpdateArgs} args - Arguments to update one Review.
     * @example
     * // Update one Review
     * const review = await prisma.review.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends ReviewUpdateArgs>(args: SelectSubset<T, ReviewUpdateArgs<ExtArgs>>): Prisma__ReviewClient<$Result.GetResult<Prisma.$ReviewPayload<ExtArgs>, T, "update">, never, ExtArgs>

    /**
     * Delete zero or more Reviews.
     * @param {ReviewDeleteManyArgs} args - Arguments to filter Reviews to delete.
     * @example
     * // Delete a few Reviews
     * const { count } = await prisma.review.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends ReviewDeleteManyArgs>(args?: SelectSubset<T, ReviewDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more Reviews.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReviewUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many Reviews
     * const review = await prisma.review.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends ReviewUpdateManyArgs>(args: SelectSubset<T, ReviewUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create or update one Review.
     * @param {ReviewUpsertArgs} args - Arguments to update or create a Review.
     * @example
     * // Update or create a Review
     * const review = await prisma.review.upsert({
     *   create: {
     *     // ... data to create a Review
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the Review we want to update
     *   }
     * })
     */
    upsert<T extends ReviewUpsertArgs>(args: SelectSubset<T, ReviewUpsertArgs<ExtArgs>>): Prisma__ReviewClient<$Result.GetResult<Prisma.$ReviewPayload<ExtArgs>, T, "upsert">, never, ExtArgs>


    /**
     * Count the number of Reviews.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReviewCountArgs} args - Arguments to filter Reviews to count.
     * @example
     * // Count the number of Reviews
     * const count = await prisma.review.count({
     *   where: {
     *     // ... the filter for the Reviews we want to count
     *   }
     * })
    **/
    count<T extends ReviewCountArgs>(
      args?: Subset<T, ReviewCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], ReviewCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a Review.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReviewAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends ReviewAggregateArgs>(args: Subset<T, ReviewAggregateArgs>): Prisma.PrismaPromise<GetReviewAggregateType<T>>

    /**
     * Group by Review.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ReviewGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends ReviewGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: ReviewGroupByArgs['orderBy'] }
        : { orderBy?: ReviewGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, ReviewGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetReviewGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the Review model
   */
  readonly fields: ReviewFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for Review.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__ReviewClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the Review model
   */ 
  interface ReviewFieldRefs {
    readonly id: FieldRef<"Review", 'String'>
    readonly orderId: FieldRef<"Review", 'String'>
    readonly productIds: FieldRef<"Review", 'String[]'>
    readonly customerId: FieldRef<"Review", 'String'>
    readonly rating: FieldRef<"Review", 'Int'>
    readonly comment: FieldRef<"Review", 'String'>
    readonly channel: FieldRef<"Review", 'String'>
    readonly createdAt: FieldRef<"Review", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * Review findUnique
   */
  export type ReviewFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelect<ExtArgs> | null
    /**
     * Filter, which Review to fetch.
     */
    where: ReviewWhereUniqueInput
  }

  /**
   * Review findUniqueOrThrow
   */
  export type ReviewFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelect<ExtArgs> | null
    /**
     * Filter, which Review to fetch.
     */
    where: ReviewWhereUniqueInput
  }

  /**
   * Review findFirst
   */
  export type ReviewFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelect<ExtArgs> | null
    /**
     * Filter, which Review to fetch.
     */
    where?: ReviewWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Reviews to fetch.
     */
    orderBy?: ReviewOrderByWithRelationInput | ReviewOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for Reviews.
     */
    cursor?: ReviewWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Reviews from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Reviews.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of Reviews.
     */
    distinct?: ReviewScalarFieldEnum | ReviewScalarFieldEnum[]
  }

  /**
   * Review findFirstOrThrow
   */
  export type ReviewFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelect<ExtArgs> | null
    /**
     * Filter, which Review to fetch.
     */
    where?: ReviewWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Reviews to fetch.
     */
    orderBy?: ReviewOrderByWithRelationInput | ReviewOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for Reviews.
     */
    cursor?: ReviewWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Reviews from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Reviews.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of Reviews.
     */
    distinct?: ReviewScalarFieldEnum | ReviewScalarFieldEnum[]
  }

  /**
   * Review findMany
   */
  export type ReviewFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelect<ExtArgs> | null
    /**
     * Filter, which Reviews to fetch.
     */
    where?: ReviewWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Reviews to fetch.
     */
    orderBy?: ReviewOrderByWithRelationInput | ReviewOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing Reviews.
     */
    cursor?: ReviewWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Reviews from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Reviews.
     */
    skip?: number
    distinct?: ReviewScalarFieldEnum | ReviewScalarFieldEnum[]
  }

  /**
   * Review create
   */
  export type ReviewCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelect<ExtArgs> | null
    /**
     * The data needed to create a Review.
     */
    data: XOR<ReviewCreateInput, ReviewUncheckedCreateInput>
  }

  /**
   * Review createMany
   */
  export type ReviewCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many Reviews.
     */
    data: ReviewCreateManyInput | ReviewCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * Review createManyAndReturn
   */
  export type ReviewCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * The data used to create many Reviews.
     */
    data: ReviewCreateManyInput | ReviewCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * Review update
   */
  export type ReviewUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelect<ExtArgs> | null
    /**
     * The data needed to update a Review.
     */
    data: XOR<ReviewUpdateInput, ReviewUncheckedUpdateInput>
    /**
     * Choose, which Review to update.
     */
    where: ReviewWhereUniqueInput
  }

  /**
   * Review updateMany
   */
  export type ReviewUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update Reviews.
     */
    data: XOR<ReviewUpdateManyMutationInput, ReviewUncheckedUpdateManyInput>
    /**
     * Filter which Reviews to update
     */
    where?: ReviewWhereInput
  }

  /**
   * Review upsert
   */
  export type ReviewUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelect<ExtArgs> | null
    /**
     * The filter to search for the Review to update in case it exists.
     */
    where: ReviewWhereUniqueInput
    /**
     * In case the Review found by the `where` argument doesn't exist, create a new Review with this data.
     */
    create: XOR<ReviewCreateInput, ReviewUncheckedCreateInput>
    /**
     * In case the Review was found with the provided `where` argument, update it with this data.
     */
    update: XOR<ReviewUpdateInput, ReviewUncheckedUpdateInput>
  }

  /**
   * Review delete
   */
  export type ReviewDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelect<ExtArgs> | null
    /**
     * Filter which Review to delete.
     */
    where: ReviewWhereUniqueInput
  }

  /**
   * Review deleteMany
   */
  export type ReviewDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which Reviews to delete
     */
    where?: ReviewWhereInput
  }

  /**
   * Review without action
   */
  export type ReviewDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Review
     */
    select?: ReviewSelect<ExtArgs> | null
  }


  /**
   * Enums
   */

  export const TransactionIsolationLevel: {
    ReadUncommitted: 'ReadUncommitted',
    ReadCommitted: 'ReadCommitted',
    RepeatableRead: 'RepeatableRead',
    Serializable: 'Serializable'
  };

  export type TransactionIsolationLevel = (typeof TransactionIsolationLevel)[keyof typeof TransactionIsolationLevel]


  export const TableScalarFieldEnum: {
    id: 'id',
    number: 'number',
    capacity: 'capacity',
    location: 'location',
    accessible: 'accessible',
    active: 'active',
    createdAt: 'createdAt'
  };

  export type TableScalarFieldEnum = (typeof TableScalarFieldEnum)[keyof typeof TableScalarFieldEnum]


  export const TimeSlotScalarFieldEnum: {
    id: 'id',
    date: 'date',
    startTime: 'startTime',
    durationMinutes: 'durationMinutes',
    maxCovers: 'maxCovers',
    reservedCovers: 'reservedCovers',
    createdAt: 'createdAt'
  };

  export type TimeSlotScalarFieldEnum = (typeof TimeSlotScalarFieldEnum)[keyof typeof TimeSlotScalarFieldEnum]


  export const ReservationScalarFieldEnum: {
    id: 'id',
    customerId: 'customerId',
    partySize: 'partySize',
    status: 'status',
    specialRequests: 'specialRequests',
    confirmedAt: 'confirmedAt',
    checkedInAt: 'checkedInAt',
    cancelledAt: 'cancelledAt',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    timeSlotId: 'timeSlotId'
  };

  export type ReservationScalarFieldEnum = (typeof ReservationScalarFieldEnum)[keyof typeof ReservationScalarFieldEnum]


  export const ReservationTableScalarFieldEnum: {
    reservationId: 'reservationId',
    tableId: 'tableId'
  };

  export type ReservationTableScalarFieldEnum = (typeof ReservationTableScalarFieldEnum)[keyof typeof ReservationTableScalarFieldEnum]


  export const WaitlistScalarFieldEnum: {
    id: 'id',
    customerId: 'customerId',
    partySize: 'partySize',
    notifiedAt: 'notifiedAt',
    expiresAt: 'expiresAt',
    createdAt: 'createdAt',
    timeSlotId: 'timeSlotId'
  };

  export type WaitlistScalarFieldEnum = (typeof WaitlistScalarFieldEnum)[keyof typeof WaitlistScalarFieldEnum]


  export const ReviewScalarFieldEnum: {
    id: 'id',
    orderId: 'orderId',
    productIds: 'productIds',
    customerId: 'customerId',
    rating: 'rating',
    comment: 'comment',
    channel: 'channel',
    createdAt: 'createdAt'
  };

  export type ReviewScalarFieldEnum = (typeof ReviewScalarFieldEnum)[keyof typeof ReviewScalarFieldEnum]


  export const SortOrder: {
    asc: 'asc',
    desc: 'desc'
  };

  export type SortOrder = (typeof SortOrder)[keyof typeof SortOrder]


  export const JsonNullValueInput: {
    JsonNull: typeof JsonNull
  };

  export type JsonNullValueInput = (typeof JsonNullValueInput)[keyof typeof JsonNullValueInput]


  export const QueryMode: {
    default: 'default',
    insensitive: 'insensitive'
  };

  export type QueryMode = (typeof QueryMode)[keyof typeof QueryMode]


  export const JsonNullValueFilter: {
    DbNull: typeof DbNull,
    JsonNull: typeof JsonNull,
    AnyNull: typeof AnyNull
  };

  export type JsonNullValueFilter = (typeof JsonNullValueFilter)[keyof typeof JsonNullValueFilter]


  export const NullsOrder: {
    first: 'first',
    last: 'last'
  };

  export type NullsOrder = (typeof NullsOrder)[keyof typeof NullsOrder]


  /**
   * Field references 
   */


  /**
   * Reference to a field of type 'String'
   */
  export type StringFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'String'>
    


  /**
   * Reference to a field of type 'String[]'
   */
  export type ListStringFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'String[]'>
    


  /**
   * Reference to a field of type 'Int'
   */
  export type IntFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Int'>
    


  /**
   * Reference to a field of type 'Int[]'
   */
  export type ListIntFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Int[]'>
    


  /**
   * Reference to a field of type 'TableLocation'
   */
  export type EnumTableLocationFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'TableLocation'>
    


  /**
   * Reference to a field of type 'TableLocation[]'
   */
  export type ListEnumTableLocationFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'TableLocation[]'>
    


  /**
   * Reference to a field of type 'Boolean'
   */
  export type BooleanFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Boolean'>
    


  /**
   * Reference to a field of type 'DateTime'
   */
  export type DateTimeFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'DateTime'>
    


  /**
   * Reference to a field of type 'DateTime[]'
   */
  export type ListDateTimeFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'DateTime[]'>
    


  /**
   * Reference to a field of type 'ReservationStatus'
   */
  export type EnumReservationStatusFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'ReservationStatus'>
    


  /**
   * Reference to a field of type 'ReservationStatus[]'
   */
  export type ListEnumReservationStatusFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'ReservationStatus[]'>
    


  /**
   * Reference to a field of type 'Json'
   */
  export type JsonFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Json'>
    


  /**
   * Reference to a field of type 'Float'
   */
  export type FloatFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Float'>
    


  /**
   * Reference to a field of type 'Float[]'
   */
  export type ListFloatFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Float[]'>
    
  /**
   * Deep Input Types
   */


  export type TableWhereInput = {
    AND?: TableWhereInput | TableWhereInput[]
    OR?: TableWhereInput[]
    NOT?: TableWhereInput | TableWhereInput[]
    id?: StringFilter<"Table"> | string
    number?: StringFilter<"Table"> | string
    capacity?: IntFilter<"Table"> | number
    location?: EnumTableLocationFilter<"Table"> | $Enums.TableLocation
    accessible?: BoolFilter<"Table"> | boolean
    active?: BoolFilter<"Table"> | boolean
    createdAt?: DateTimeFilter<"Table"> | Date | string
    reservationTables?: ReservationTableListRelationFilter
  }

  export type TableOrderByWithRelationInput = {
    id?: SortOrder
    number?: SortOrder
    capacity?: SortOrder
    location?: SortOrder
    accessible?: SortOrder
    active?: SortOrder
    createdAt?: SortOrder
    reservationTables?: ReservationTableOrderByRelationAggregateInput
  }

  export type TableWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    number?: string
    AND?: TableWhereInput | TableWhereInput[]
    OR?: TableWhereInput[]
    NOT?: TableWhereInput | TableWhereInput[]
    capacity?: IntFilter<"Table"> | number
    location?: EnumTableLocationFilter<"Table"> | $Enums.TableLocation
    accessible?: BoolFilter<"Table"> | boolean
    active?: BoolFilter<"Table"> | boolean
    createdAt?: DateTimeFilter<"Table"> | Date | string
    reservationTables?: ReservationTableListRelationFilter
  }, "id" | "number">

  export type TableOrderByWithAggregationInput = {
    id?: SortOrder
    number?: SortOrder
    capacity?: SortOrder
    location?: SortOrder
    accessible?: SortOrder
    active?: SortOrder
    createdAt?: SortOrder
    _count?: TableCountOrderByAggregateInput
    _avg?: TableAvgOrderByAggregateInput
    _max?: TableMaxOrderByAggregateInput
    _min?: TableMinOrderByAggregateInput
    _sum?: TableSumOrderByAggregateInput
  }

  export type TableScalarWhereWithAggregatesInput = {
    AND?: TableScalarWhereWithAggregatesInput | TableScalarWhereWithAggregatesInput[]
    OR?: TableScalarWhereWithAggregatesInput[]
    NOT?: TableScalarWhereWithAggregatesInput | TableScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"Table"> | string
    number?: StringWithAggregatesFilter<"Table"> | string
    capacity?: IntWithAggregatesFilter<"Table"> | number
    location?: EnumTableLocationWithAggregatesFilter<"Table"> | $Enums.TableLocation
    accessible?: BoolWithAggregatesFilter<"Table"> | boolean
    active?: BoolWithAggregatesFilter<"Table"> | boolean
    createdAt?: DateTimeWithAggregatesFilter<"Table"> | Date | string
  }

  export type TimeSlotWhereInput = {
    AND?: TimeSlotWhereInput | TimeSlotWhereInput[]
    OR?: TimeSlotWhereInput[]
    NOT?: TimeSlotWhereInput | TimeSlotWhereInput[]
    id?: StringFilter<"TimeSlot"> | string
    date?: DateTimeFilter<"TimeSlot"> | Date | string
    startTime?: StringFilter<"TimeSlot"> | string
    durationMinutes?: IntFilter<"TimeSlot"> | number
    maxCovers?: IntFilter<"TimeSlot"> | number
    reservedCovers?: IntFilter<"TimeSlot"> | number
    createdAt?: DateTimeFilter<"TimeSlot"> | Date | string
    reservations?: ReservationListRelationFilter
    waitlist?: WaitlistListRelationFilter
  }

  export type TimeSlotOrderByWithRelationInput = {
    id?: SortOrder
    date?: SortOrder
    startTime?: SortOrder
    durationMinutes?: SortOrder
    maxCovers?: SortOrder
    reservedCovers?: SortOrder
    createdAt?: SortOrder
    reservations?: ReservationOrderByRelationAggregateInput
    waitlist?: WaitlistOrderByRelationAggregateInput
  }

  export type TimeSlotWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    date_startTime?: TimeSlotDateStartTimeCompoundUniqueInput
    AND?: TimeSlotWhereInput | TimeSlotWhereInput[]
    OR?: TimeSlotWhereInput[]
    NOT?: TimeSlotWhereInput | TimeSlotWhereInput[]
    date?: DateTimeFilter<"TimeSlot"> | Date | string
    startTime?: StringFilter<"TimeSlot"> | string
    durationMinutes?: IntFilter<"TimeSlot"> | number
    maxCovers?: IntFilter<"TimeSlot"> | number
    reservedCovers?: IntFilter<"TimeSlot"> | number
    createdAt?: DateTimeFilter<"TimeSlot"> | Date | string
    reservations?: ReservationListRelationFilter
    waitlist?: WaitlistListRelationFilter
  }, "id" | "date_startTime">

  export type TimeSlotOrderByWithAggregationInput = {
    id?: SortOrder
    date?: SortOrder
    startTime?: SortOrder
    durationMinutes?: SortOrder
    maxCovers?: SortOrder
    reservedCovers?: SortOrder
    createdAt?: SortOrder
    _count?: TimeSlotCountOrderByAggregateInput
    _avg?: TimeSlotAvgOrderByAggregateInput
    _max?: TimeSlotMaxOrderByAggregateInput
    _min?: TimeSlotMinOrderByAggregateInput
    _sum?: TimeSlotSumOrderByAggregateInput
  }

  export type TimeSlotScalarWhereWithAggregatesInput = {
    AND?: TimeSlotScalarWhereWithAggregatesInput | TimeSlotScalarWhereWithAggregatesInput[]
    OR?: TimeSlotScalarWhereWithAggregatesInput[]
    NOT?: TimeSlotScalarWhereWithAggregatesInput | TimeSlotScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"TimeSlot"> | string
    date?: DateTimeWithAggregatesFilter<"TimeSlot"> | Date | string
    startTime?: StringWithAggregatesFilter<"TimeSlot"> | string
    durationMinutes?: IntWithAggregatesFilter<"TimeSlot"> | number
    maxCovers?: IntWithAggregatesFilter<"TimeSlot"> | number
    reservedCovers?: IntWithAggregatesFilter<"TimeSlot"> | number
    createdAt?: DateTimeWithAggregatesFilter<"TimeSlot"> | Date | string
  }

  export type ReservationWhereInput = {
    AND?: ReservationWhereInput | ReservationWhereInput[]
    OR?: ReservationWhereInput[]
    NOT?: ReservationWhereInput | ReservationWhereInput[]
    id?: StringFilter<"Reservation"> | string
    customerId?: StringFilter<"Reservation"> | string
    partySize?: IntFilter<"Reservation"> | number
    status?: EnumReservationStatusFilter<"Reservation"> | $Enums.ReservationStatus
    specialRequests?: JsonFilter<"Reservation">
    confirmedAt?: DateTimeNullableFilter<"Reservation"> | Date | string | null
    checkedInAt?: DateTimeNullableFilter<"Reservation"> | Date | string | null
    cancelledAt?: DateTimeNullableFilter<"Reservation"> | Date | string | null
    createdAt?: DateTimeFilter<"Reservation"> | Date | string
    updatedAt?: DateTimeFilter<"Reservation"> | Date | string
    timeSlotId?: StringFilter<"Reservation"> | string
    timeSlot?: XOR<TimeSlotRelationFilter, TimeSlotWhereInput>
    tables?: ReservationTableListRelationFilter
  }

  export type ReservationOrderByWithRelationInput = {
    id?: SortOrder
    customerId?: SortOrder
    partySize?: SortOrder
    status?: SortOrder
    specialRequests?: SortOrder
    confirmedAt?: SortOrderInput | SortOrder
    checkedInAt?: SortOrderInput | SortOrder
    cancelledAt?: SortOrderInput | SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    timeSlotId?: SortOrder
    timeSlot?: TimeSlotOrderByWithRelationInput
    tables?: ReservationTableOrderByRelationAggregateInput
  }

  export type ReservationWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    AND?: ReservationWhereInput | ReservationWhereInput[]
    OR?: ReservationWhereInput[]
    NOT?: ReservationWhereInput | ReservationWhereInput[]
    customerId?: StringFilter<"Reservation"> | string
    partySize?: IntFilter<"Reservation"> | number
    status?: EnumReservationStatusFilter<"Reservation"> | $Enums.ReservationStatus
    specialRequests?: JsonFilter<"Reservation">
    confirmedAt?: DateTimeNullableFilter<"Reservation"> | Date | string | null
    checkedInAt?: DateTimeNullableFilter<"Reservation"> | Date | string | null
    cancelledAt?: DateTimeNullableFilter<"Reservation"> | Date | string | null
    createdAt?: DateTimeFilter<"Reservation"> | Date | string
    updatedAt?: DateTimeFilter<"Reservation"> | Date | string
    timeSlotId?: StringFilter<"Reservation"> | string
    timeSlot?: XOR<TimeSlotRelationFilter, TimeSlotWhereInput>
    tables?: ReservationTableListRelationFilter
  }, "id">

  export type ReservationOrderByWithAggregationInput = {
    id?: SortOrder
    customerId?: SortOrder
    partySize?: SortOrder
    status?: SortOrder
    specialRequests?: SortOrder
    confirmedAt?: SortOrderInput | SortOrder
    checkedInAt?: SortOrderInput | SortOrder
    cancelledAt?: SortOrderInput | SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    timeSlotId?: SortOrder
    _count?: ReservationCountOrderByAggregateInput
    _avg?: ReservationAvgOrderByAggregateInput
    _max?: ReservationMaxOrderByAggregateInput
    _min?: ReservationMinOrderByAggregateInput
    _sum?: ReservationSumOrderByAggregateInput
  }

  export type ReservationScalarWhereWithAggregatesInput = {
    AND?: ReservationScalarWhereWithAggregatesInput | ReservationScalarWhereWithAggregatesInput[]
    OR?: ReservationScalarWhereWithAggregatesInput[]
    NOT?: ReservationScalarWhereWithAggregatesInput | ReservationScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"Reservation"> | string
    customerId?: StringWithAggregatesFilter<"Reservation"> | string
    partySize?: IntWithAggregatesFilter<"Reservation"> | number
    status?: EnumReservationStatusWithAggregatesFilter<"Reservation"> | $Enums.ReservationStatus
    specialRequests?: JsonWithAggregatesFilter<"Reservation">
    confirmedAt?: DateTimeNullableWithAggregatesFilter<"Reservation"> | Date | string | null
    checkedInAt?: DateTimeNullableWithAggregatesFilter<"Reservation"> | Date | string | null
    cancelledAt?: DateTimeNullableWithAggregatesFilter<"Reservation"> | Date | string | null
    createdAt?: DateTimeWithAggregatesFilter<"Reservation"> | Date | string
    updatedAt?: DateTimeWithAggregatesFilter<"Reservation"> | Date | string
    timeSlotId?: StringWithAggregatesFilter<"Reservation"> | string
  }

  export type ReservationTableWhereInput = {
    AND?: ReservationTableWhereInput | ReservationTableWhereInput[]
    OR?: ReservationTableWhereInput[]
    NOT?: ReservationTableWhereInput | ReservationTableWhereInput[]
    reservationId?: StringFilter<"ReservationTable"> | string
    tableId?: StringFilter<"ReservationTable"> | string
    reservation?: XOR<ReservationRelationFilter, ReservationWhereInput>
    table?: XOR<TableRelationFilter, TableWhereInput>
  }

  export type ReservationTableOrderByWithRelationInput = {
    reservationId?: SortOrder
    tableId?: SortOrder
    reservation?: ReservationOrderByWithRelationInput
    table?: TableOrderByWithRelationInput
  }

  export type ReservationTableWhereUniqueInput = Prisma.AtLeast<{
    reservationId_tableId?: ReservationTableReservationIdTableIdCompoundUniqueInput
    AND?: ReservationTableWhereInput | ReservationTableWhereInput[]
    OR?: ReservationTableWhereInput[]
    NOT?: ReservationTableWhereInput | ReservationTableWhereInput[]
    reservationId?: StringFilter<"ReservationTable"> | string
    tableId?: StringFilter<"ReservationTable"> | string
    reservation?: XOR<ReservationRelationFilter, ReservationWhereInput>
    table?: XOR<TableRelationFilter, TableWhereInput>
  }, "reservationId_tableId">

  export type ReservationTableOrderByWithAggregationInput = {
    reservationId?: SortOrder
    tableId?: SortOrder
    _count?: ReservationTableCountOrderByAggregateInput
    _max?: ReservationTableMaxOrderByAggregateInput
    _min?: ReservationTableMinOrderByAggregateInput
  }

  export type ReservationTableScalarWhereWithAggregatesInput = {
    AND?: ReservationTableScalarWhereWithAggregatesInput | ReservationTableScalarWhereWithAggregatesInput[]
    OR?: ReservationTableScalarWhereWithAggregatesInput[]
    NOT?: ReservationTableScalarWhereWithAggregatesInput | ReservationTableScalarWhereWithAggregatesInput[]
    reservationId?: StringWithAggregatesFilter<"ReservationTable"> | string
    tableId?: StringWithAggregatesFilter<"ReservationTable"> | string
  }

  export type WaitlistWhereInput = {
    AND?: WaitlistWhereInput | WaitlistWhereInput[]
    OR?: WaitlistWhereInput[]
    NOT?: WaitlistWhereInput | WaitlistWhereInput[]
    id?: StringFilter<"Waitlist"> | string
    customerId?: StringFilter<"Waitlist"> | string
    partySize?: IntFilter<"Waitlist"> | number
    notifiedAt?: DateTimeNullableFilter<"Waitlist"> | Date | string | null
    expiresAt?: DateTimeFilter<"Waitlist"> | Date | string
    createdAt?: DateTimeFilter<"Waitlist"> | Date | string
    timeSlotId?: StringFilter<"Waitlist"> | string
    timeSlot?: XOR<TimeSlotRelationFilter, TimeSlotWhereInput>
  }

  export type WaitlistOrderByWithRelationInput = {
    id?: SortOrder
    customerId?: SortOrder
    partySize?: SortOrder
    notifiedAt?: SortOrderInput | SortOrder
    expiresAt?: SortOrder
    createdAt?: SortOrder
    timeSlotId?: SortOrder
    timeSlot?: TimeSlotOrderByWithRelationInput
  }

  export type WaitlistWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    AND?: WaitlistWhereInput | WaitlistWhereInput[]
    OR?: WaitlistWhereInput[]
    NOT?: WaitlistWhereInput | WaitlistWhereInput[]
    customerId?: StringFilter<"Waitlist"> | string
    partySize?: IntFilter<"Waitlist"> | number
    notifiedAt?: DateTimeNullableFilter<"Waitlist"> | Date | string | null
    expiresAt?: DateTimeFilter<"Waitlist"> | Date | string
    createdAt?: DateTimeFilter<"Waitlist"> | Date | string
    timeSlotId?: StringFilter<"Waitlist"> | string
    timeSlot?: XOR<TimeSlotRelationFilter, TimeSlotWhereInput>
  }, "id">

  export type WaitlistOrderByWithAggregationInput = {
    id?: SortOrder
    customerId?: SortOrder
    partySize?: SortOrder
    notifiedAt?: SortOrderInput | SortOrder
    expiresAt?: SortOrder
    createdAt?: SortOrder
    timeSlotId?: SortOrder
    _count?: WaitlistCountOrderByAggregateInput
    _avg?: WaitlistAvgOrderByAggregateInput
    _max?: WaitlistMaxOrderByAggregateInput
    _min?: WaitlistMinOrderByAggregateInput
    _sum?: WaitlistSumOrderByAggregateInput
  }

  export type WaitlistScalarWhereWithAggregatesInput = {
    AND?: WaitlistScalarWhereWithAggregatesInput | WaitlistScalarWhereWithAggregatesInput[]
    OR?: WaitlistScalarWhereWithAggregatesInput[]
    NOT?: WaitlistScalarWhereWithAggregatesInput | WaitlistScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"Waitlist"> | string
    customerId?: StringWithAggregatesFilter<"Waitlist"> | string
    partySize?: IntWithAggregatesFilter<"Waitlist"> | number
    notifiedAt?: DateTimeNullableWithAggregatesFilter<"Waitlist"> | Date | string | null
    expiresAt?: DateTimeWithAggregatesFilter<"Waitlist"> | Date | string
    createdAt?: DateTimeWithAggregatesFilter<"Waitlist"> | Date | string
    timeSlotId?: StringWithAggregatesFilter<"Waitlist"> | string
  }

  export type ReviewWhereInput = {
    AND?: ReviewWhereInput | ReviewWhereInput[]
    OR?: ReviewWhereInput[]
    NOT?: ReviewWhereInput | ReviewWhereInput[]
    id?: StringFilter<"Review"> | string
    orderId?: StringFilter<"Review"> | string
    productIds?: StringNullableListFilter<"Review">
    customerId?: StringFilter<"Review"> | string
    rating?: IntFilter<"Review"> | number
    comment?: StringNullableFilter<"Review"> | string | null
    channel?: StringFilter<"Review"> | string
    createdAt?: DateTimeFilter<"Review"> | Date | string
  }

  export type ReviewOrderByWithRelationInput = {
    id?: SortOrder
    orderId?: SortOrder
    productIds?: SortOrder
    customerId?: SortOrder
    rating?: SortOrder
    comment?: SortOrderInput | SortOrder
    channel?: SortOrder
    createdAt?: SortOrder
  }

  export type ReviewWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    AND?: ReviewWhereInput | ReviewWhereInput[]
    OR?: ReviewWhereInput[]
    NOT?: ReviewWhereInput | ReviewWhereInput[]
    orderId?: StringFilter<"Review"> | string
    productIds?: StringNullableListFilter<"Review">
    customerId?: StringFilter<"Review"> | string
    rating?: IntFilter<"Review"> | number
    comment?: StringNullableFilter<"Review"> | string | null
    channel?: StringFilter<"Review"> | string
    createdAt?: DateTimeFilter<"Review"> | Date | string
  }, "id">

  export type ReviewOrderByWithAggregationInput = {
    id?: SortOrder
    orderId?: SortOrder
    productIds?: SortOrder
    customerId?: SortOrder
    rating?: SortOrder
    comment?: SortOrderInput | SortOrder
    channel?: SortOrder
    createdAt?: SortOrder
    _count?: ReviewCountOrderByAggregateInput
    _avg?: ReviewAvgOrderByAggregateInput
    _max?: ReviewMaxOrderByAggregateInput
    _min?: ReviewMinOrderByAggregateInput
    _sum?: ReviewSumOrderByAggregateInput
  }

  export type ReviewScalarWhereWithAggregatesInput = {
    AND?: ReviewScalarWhereWithAggregatesInput | ReviewScalarWhereWithAggregatesInput[]
    OR?: ReviewScalarWhereWithAggregatesInput[]
    NOT?: ReviewScalarWhereWithAggregatesInput | ReviewScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"Review"> | string
    orderId?: StringWithAggregatesFilter<"Review"> | string
    productIds?: StringNullableListFilter<"Review">
    customerId?: StringWithAggregatesFilter<"Review"> | string
    rating?: IntWithAggregatesFilter<"Review"> | number
    comment?: StringNullableWithAggregatesFilter<"Review"> | string | null
    channel?: StringWithAggregatesFilter<"Review"> | string
    createdAt?: DateTimeWithAggregatesFilter<"Review"> | Date | string
  }

  export type TableCreateInput = {
    id?: string
    number: string
    capacity: number
    location: $Enums.TableLocation
    accessible?: boolean
    active?: boolean
    createdAt?: Date | string
    reservationTables?: ReservationTableCreateNestedManyWithoutTableInput
  }

  export type TableUncheckedCreateInput = {
    id?: string
    number: string
    capacity: number
    location: $Enums.TableLocation
    accessible?: boolean
    active?: boolean
    createdAt?: Date | string
    reservationTables?: ReservationTableUncheckedCreateNestedManyWithoutTableInput
  }

  export type TableUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    capacity?: IntFieldUpdateOperationsInput | number
    location?: EnumTableLocationFieldUpdateOperationsInput | $Enums.TableLocation
    accessible?: BoolFieldUpdateOperationsInput | boolean
    active?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    reservationTables?: ReservationTableUpdateManyWithoutTableNestedInput
  }

  export type TableUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    capacity?: IntFieldUpdateOperationsInput | number
    location?: EnumTableLocationFieldUpdateOperationsInput | $Enums.TableLocation
    accessible?: BoolFieldUpdateOperationsInput | boolean
    active?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    reservationTables?: ReservationTableUncheckedUpdateManyWithoutTableNestedInput
  }

  export type TableCreateManyInput = {
    id?: string
    number: string
    capacity: number
    location: $Enums.TableLocation
    accessible?: boolean
    active?: boolean
    createdAt?: Date | string
  }

  export type TableUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    capacity?: IntFieldUpdateOperationsInput | number
    location?: EnumTableLocationFieldUpdateOperationsInput | $Enums.TableLocation
    accessible?: BoolFieldUpdateOperationsInput | boolean
    active?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type TableUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    capacity?: IntFieldUpdateOperationsInput | number
    location?: EnumTableLocationFieldUpdateOperationsInput | $Enums.TableLocation
    accessible?: BoolFieldUpdateOperationsInput | boolean
    active?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type TimeSlotCreateInput = {
    id?: string
    date: Date | string
    startTime: string
    durationMinutes?: number
    maxCovers: number
    reservedCovers?: number
    createdAt?: Date | string
    reservations?: ReservationCreateNestedManyWithoutTimeSlotInput
    waitlist?: WaitlistCreateNestedManyWithoutTimeSlotInput
  }

  export type TimeSlotUncheckedCreateInput = {
    id?: string
    date: Date | string
    startTime: string
    durationMinutes?: number
    maxCovers: number
    reservedCovers?: number
    createdAt?: Date | string
    reservations?: ReservationUncheckedCreateNestedManyWithoutTimeSlotInput
    waitlist?: WaitlistUncheckedCreateNestedManyWithoutTimeSlotInput
  }

  export type TimeSlotUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    date?: DateTimeFieldUpdateOperationsInput | Date | string
    startTime?: StringFieldUpdateOperationsInput | string
    durationMinutes?: IntFieldUpdateOperationsInput | number
    maxCovers?: IntFieldUpdateOperationsInput | number
    reservedCovers?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    reservations?: ReservationUpdateManyWithoutTimeSlotNestedInput
    waitlist?: WaitlistUpdateManyWithoutTimeSlotNestedInput
  }

  export type TimeSlotUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    date?: DateTimeFieldUpdateOperationsInput | Date | string
    startTime?: StringFieldUpdateOperationsInput | string
    durationMinutes?: IntFieldUpdateOperationsInput | number
    maxCovers?: IntFieldUpdateOperationsInput | number
    reservedCovers?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    reservations?: ReservationUncheckedUpdateManyWithoutTimeSlotNestedInput
    waitlist?: WaitlistUncheckedUpdateManyWithoutTimeSlotNestedInput
  }

  export type TimeSlotCreateManyInput = {
    id?: string
    date: Date | string
    startTime: string
    durationMinutes?: number
    maxCovers: number
    reservedCovers?: number
    createdAt?: Date | string
  }

  export type TimeSlotUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    date?: DateTimeFieldUpdateOperationsInput | Date | string
    startTime?: StringFieldUpdateOperationsInput | string
    durationMinutes?: IntFieldUpdateOperationsInput | number
    maxCovers?: IntFieldUpdateOperationsInput | number
    reservedCovers?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type TimeSlotUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    date?: DateTimeFieldUpdateOperationsInput | Date | string
    startTime?: StringFieldUpdateOperationsInput | string
    durationMinutes?: IntFieldUpdateOperationsInput | number
    maxCovers?: IntFieldUpdateOperationsInput | number
    reservedCovers?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type ReservationCreateInput = {
    id?: string
    customerId: string
    partySize: number
    status?: $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: Date | string | null
    checkedInAt?: Date | string | null
    cancelledAt?: Date | string | null
    createdAt?: Date | string
    updatedAt?: Date | string
    timeSlot: TimeSlotCreateNestedOneWithoutReservationsInput
    tables?: ReservationTableCreateNestedManyWithoutReservationInput
  }

  export type ReservationUncheckedCreateInput = {
    id?: string
    customerId: string
    partySize: number
    status?: $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: Date | string | null
    checkedInAt?: Date | string | null
    cancelledAt?: Date | string | null
    createdAt?: Date | string
    updatedAt?: Date | string
    timeSlotId: string
    tables?: ReservationTableUncheckedCreateNestedManyWithoutReservationInput
  }

  export type ReservationUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    status?: EnumReservationStatusFieldUpdateOperationsInput | $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    checkedInAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    cancelledAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    timeSlot?: TimeSlotUpdateOneRequiredWithoutReservationsNestedInput
    tables?: ReservationTableUpdateManyWithoutReservationNestedInput
  }

  export type ReservationUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    status?: EnumReservationStatusFieldUpdateOperationsInput | $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    checkedInAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    cancelledAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    timeSlotId?: StringFieldUpdateOperationsInput | string
    tables?: ReservationTableUncheckedUpdateManyWithoutReservationNestedInput
  }

  export type ReservationCreateManyInput = {
    id?: string
    customerId: string
    partySize: number
    status?: $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: Date | string | null
    checkedInAt?: Date | string | null
    cancelledAt?: Date | string | null
    createdAt?: Date | string
    updatedAt?: Date | string
    timeSlotId: string
  }

  export type ReservationUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    status?: EnumReservationStatusFieldUpdateOperationsInput | $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    checkedInAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    cancelledAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type ReservationUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    status?: EnumReservationStatusFieldUpdateOperationsInput | $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    checkedInAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    cancelledAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    timeSlotId?: StringFieldUpdateOperationsInput | string
  }

  export type ReservationTableCreateInput = {
    reservation: ReservationCreateNestedOneWithoutTablesInput
    table: TableCreateNestedOneWithoutReservationTablesInput
  }

  export type ReservationTableUncheckedCreateInput = {
    reservationId: string
    tableId: string
  }

  export type ReservationTableUpdateInput = {
    reservation?: ReservationUpdateOneRequiredWithoutTablesNestedInput
    table?: TableUpdateOneRequiredWithoutReservationTablesNestedInput
  }

  export type ReservationTableUncheckedUpdateInput = {
    reservationId?: StringFieldUpdateOperationsInput | string
    tableId?: StringFieldUpdateOperationsInput | string
  }

  export type ReservationTableCreateManyInput = {
    reservationId: string
    tableId: string
  }

  export type ReservationTableUpdateManyMutationInput = {

  }

  export type ReservationTableUncheckedUpdateManyInput = {
    reservationId?: StringFieldUpdateOperationsInput | string
    tableId?: StringFieldUpdateOperationsInput | string
  }

  export type WaitlistCreateInput = {
    id?: string
    customerId: string
    partySize: number
    notifiedAt?: Date | string | null
    expiresAt: Date | string
    createdAt?: Date | string
    timeSlot: TimeSlotCreateNestedOneWithoutWaitlistInput
  }

  export type WaitlistUncheckedCreateInput = {
    id?: string
    customerId: string
    partySize: number
    notifiedAt?: Date | string | null
    expiresAt: Date | string
    createdAt?: Date | string
    timeSlotId: string
  }

  export type WaitlistUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    notifiedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    expiresAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    timeSlot?: TimeSlotUpdateOneRequiredWithoutWaitlistNestedInput
  }

  export type WaitlistUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    notifiedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    expiresAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    timeSlotId?: StringFieldUpdateOperationsInput | string
  }

  export type WaitlistCreateManyInput = {
    id?: string
    customerId: string
    partySize: number
    notifiedAt?: Date | string | null
    expiresAt: Date | string
    createdAt?: Date | string
    timeSlotId: string
  }

  export type WaitlistUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    notifiedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    expiresAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type WaitlistUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    notifiedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    expiresAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    timeSlotId?: StringFieldUpdateOperationsInput | string
  }

  export type ReviewCreateInput = {
    id?: string
    orderId: string
    productIds?: ReviewCreateproductIdsInput | string[]
    customerId: string
    rating: number
    comment?: string | null
    channel: string
    createdAt?: Date | string
  }

  export type ReviewUncheckedCreateInput = {
    id?: string
    orderId: string
    productIds?: ReviewCreateproductIdsInput | string[]
    customerId: string
    rating: number
    comment?: string | null
    channel: string
    createdAt?: Date | string
  }

  export type ReviewUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    orderId?: StringFieldUpdateOperationsInput | string
    productIds?: ReviewUpdateproductIdsInput | string[]
    customerId?: StringFieldUpdateOperationsInput | string
    rating?: IntFieldUpdateOperationsInput | number
    comment?: NullableStringFieldUpdateOperationsInput | string | null
    channel?: StringFieldUpdateOperationsInput | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type ReviewUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    orderId?: StringFieldUpdateOperationsInput | string
    productIds?: ReviewUpdateproductIdsInput | string[]
    customerId?: StringFieldUpdateOperationsInput | string
    rating?: IntFieldUpdateOperationsInput | number
    comment?: NullableStringFieldUpdateOperationsInput | string | null
    channel?: StringFieldUpdateOperationsInput | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type ReviewCreateManyInput = {
    id?: string
    orderId: string
    productIds?: ReviewCreateproductIdsInput | string[]
    customerId: string
    rating: number
    comment?: string | null
    channel: string
    createdAt?: Date | string
  }

  export type ReviewUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    orderId?: StringFieldUpdateOperationsInput | string
    productIds?: ReviewUpdateproductIdsInput | string[]
    customerId?: StringFieldUpdateOperationsInput | string
    rating?: IntFieldUpdateOperationsInput | number
    comment?: NullableStringFieldUpdateOperationsInput | string | null
    channel?: StringFieldUpdateOperationsInput | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type ReviewUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    orderId?: StringFieldUpdateOperationsInput | string
    productIds?: ReviewUpdateproductIdsInput | string[]
    customerId?: StringFieldUpdateOperationsInput | string
    rating?: IntFieldUpdateOperationsInput | number
    comment?: NullableStringFieldUpdateOperationsInput | string | null
    channel?: StringFieldUpdateOperationsInput | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type StringFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    mode?: QueryMode
    not?: NestedStringFilter<$PrismaModel> | string
  }

  export type IntFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntFilter<$PrismaModel> | number
  }

  export type EnumTableLocationFilter<$PrismaModel = never> = {
    equals?: $Enums.TableLocation | EnumTableLocationFieldRefInput<$PrismaModel>
    in?: $Enums.TableLocation[] | ListEnumTableLocationFieldRefInput<$PrismaModel>
    notIn?: $Enums.TableLocation[] | ListEnumTableLocationFieldRefInput<$PrismaModel>
    not?: NestedEnumTableLocationFilter<$PrismaModel> | $Enums.TableLocation
  }

  export type BoolFilter<$PrismaModel = never> = {
    equals?: boolean | BooleanFieldRefInput<$PrismaModel>
    not?: NestedBoolFilter<$PrismaModel> | boolean
  }

  export type DateTimeFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeFilter<$PrismaModel> | Date | string
  }

  export type ReservationTableListRelationFilter = {
    every?: ReservationTableWhereInput
    some?: ReservationTableWhereInput
    none?: ReservationTableWhereInput
  }

  export type ReservationTableOrderByRelationAggregateInput = {
    _count?: SortOrder
  }

  export type TableCountOrderByAggregateInput = {
    id?: SortOrder
    number?: SortOrder
    capacity?: SortOrder
    location?: SortOrder
    accessible?: SortOrder
    active?: SortOrder
    createdAt?: SortOrder
  }

  export type TableAvgOrderByAggregateInput = {
    capacity?: SortOrder
  }

  export type TableMaxOrderByAggregateInput = {
    id?: SortOrder
    number?: SortOrder
    capacity?: SortOrder
    location?: SortOrder
    accessible?: SortOrder
    active?: SortOrder
    createdAt?: SortOrder
  }

  export type TableMinOrderByAggregateInput = {
    id?: SortOrder
    number?: SortOrder
    capacity?: SortOrder
    location?: SortOrder
    accessible?: SortOrder
    active?: SortOrder
    createdAt?: SortOrder
  }

  export type TableSumOrderByAggregateInput = {
    capacity?: SortOrder
  }

  export type StringWithAggregatesFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    mode?: QueryMode
    not?: NestedStringWithAggregatesFilter<$PrismaModel> | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedStringFilter<$PrismaModel>
    _max?: NestedStringFilter<$PrismaModel>
  }

  export type IntWithAggregatesFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntWithAggregatesFilter<$PrismaModel> | number
    _count?: NestedIntFilter<$PrismaModel>
    _avg?: NestedFloatFilter<$PrismaModel>
    _sum?: NestedIntFilter<$PrismaModel>
    _min?: NestedIntFilter<$PrismaModel>
    _max?: NestedIntFilter<$PrismaModel>
  }

  export type EnumTableLocationWithAggregatesFilter<$PrismaModel = never> = {
    equals?: $Enums.TableLocation | EnumTableLocationFieldRefInput<$PrismaModel>
    in?: $Enums.TableLocation[] | ListEnumTableLocationFieldRefInput<$PrismaModel>
    notIn?: $Enums.TableLocation[] | ListEnumTableLocationFieldRefInput<$PrismaModel>
    not?: NestedEnumTableLocationWithAggregatesFilter<$PrismaModel> | $Enums.TableLocation
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedEnumTableLocationFilter<$PrismaModel>
    _max?: NestedEnumTableLocationFilter<$PrismaModel>
  }

  export type BoolWithAggregatesFilter<$PrismaModel = never> = {
    equals?: boolean | BooleanFieldRefInput<$PrismaModel>
    not?: NestedBoolWithAggregatesFilter<$PrismaModel> | boolean
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedBoolFilter<$PrismaModel>
    _max?: NestedBoolFilter<$PrismaModel>
  }

  export type DateTimeWithAggregatesFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeWithAggregatesFilter<$PrismaModel> | Date | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedDateTimeFilter<$PrismaModel>
    _max?: NestedDateTimeFilter<$PrismaModel>
  }

  export type ReservationListRelationFilter = {
    every?: ReservationWhereInput
    some?: ReservationWhereInput
    none?: ReservationWhereInput
  }

  export type WaitlistListRelationFilter = {
    every?: WaitlistWhereInput
    some?: WaitlistWhereInput
    none?: WaitlistWhereInput
  }

  export type ReservationOrderByRelationAggregateInput = {
    _count?: SortOrder
  }

  export type WaitlistOrderByRelationAggregateInput = {
    _count?: SortOrder
  }

  export type TimeSlotDateStartTimeCompoundUniqueInput = {
    date: Date | string
    startTime: string
  }

  export type TimeSlotCountOrderByAggregateInput = {
    id?: SortOrder
    date?: SortOrder
    startTime?: SortOrder
    durationMinutes?: SortOrder
    maxCovers?: SortOrder
    reservedCovers?: SortOrder
    createdAt?: SortOrder
  }

  export type TimeSlotAvgOrderByAggregateInput = {
    durationMinutes?: SortOrder
    maxCovers?: SortOrder
    reservedCovers?: SortOrder
  }

  export type TimeSlotMaxOrderByAggregateInput = {
    id?: SortOrder
    date?: SortOrder
    startTime?: SortOrder
    durationMinutes?: SortOrder
    maxCovers?: SortOrder
    reservedCovers?: SortOrder
    createdAt?: SortOrder
  }

  export type TimeSlotMinOrderByAggregateInput = {
    id?: SortOrder
    date?: SortOrder
    startTime?: SortOrder
    durationMinutes?: SortOrder
    maxCovers?: SortOrder
    reservedCovers?: SortOrder
    createdAt?: SortOrder
  }

  export type TimeSlotSumOrderByAggregateInput = {
    durationMinutes?: SortOrder
    maxCovers?: SortOrder
    reservedCovers?: SortOrder
  }

  export type EnumReservationStatusFilter<$PrismaModel = never> = {
    equals?: $Enums.ReservationStatus | EnumReservationStatusFieldRefInput<$PrismaModel>
    in?: $Enums.ReservationStatus[] | ListEnumReservationStatusFieldRefInput<$PrismaModel>
    notIn?: $Enums.ReservationStatus[] | ListEnumReservationStatusFieldRefInput<$PrismaModel>
    not?: NestedEnumReservationStatusFilter<$PrismaModel> | $Enums.ReservationStatus
  }
  export type JsonFilter<$PrismaModel = never> = 
    | PatchUndefined<
        Either<Required<JsonFilterBase<$PrismaModel>>, Exclude<keyof Required<JsonFilterBase<$PrismaModel>>, 'path'>>,
        Required<JsonFilterBase<$PrismaModel>>
      >
    | OptionalFlat<Omit<Required<JsonFilterBase<$PrismaModel>>, 'path'>>

  export type JsonFilterBase<$PrismaModel = never> = {
    equals?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    path?: string[]
    string_contains?: string | StringFieldRefInput<$PrismaModel>
    string_starts_with?: string | StringFieldRefInput<$PrismaModel>
    string_ends_with?: string | StringFieldRefInput<$PrismaModel>
    array_contains?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_starts_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_ends_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    lt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    lte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    not?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
  }

  export type DateTimeNullableFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel> | null
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeNullableFilter<$PrismaModel> | Date | string | null
  }

  export type TimeSlotRelationFilter = {
    is?: TimeSlotWhereInput
    isNot?: TimeSlotWhereInput
  }

  export type SortOrderInput = {
    sort: SortOrder
    nulls?: NullsOrder
  }

  export type ReservationCountOrderByAggregateInput = {
    id?: SortOrder
    customerId?: SortOrder
    partySize?: SortOrder
    status?: SortOrder
    specialRequests?: SortOrder
    confirmedAt?: SortOrder
    checkedInAt?: SortOrder
    cancelledAt?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    timeSlotId?: SortOrder
  }

  export type ReservationAvgOrderByAggregateInput = {
    partySize?: SortOrder
  }

  export type ReservationMaxOrderByAggregateInput = {
    id?: SortOrder
    customerId?: SortOrder
    partySize?: SortOrder
    status?: SortOrder
    confirmedAt?: SortOrder
    checkedInAt?: SortOrder
    cancelledAt?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    timeSlotId?: SortOrder
  }

  export type ReservationMinOrderByAggregateInput = {
    id?: SortOrder
    customerId?: SortOrder
    partySize?: SortOrder
    status?: SortOrder
    confirmedAt?: SortOrder
    checkedInAt?: SortOrder
    cancelledAt?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    timeSlotId?: SortOrder
  }

  export type ReservationSumOrderByAggregateInput = {
    partySize?: SortOrder
  }

  export type EnumReservationStatusWithAggregatesFilter<$PrismaModel = never> = {
    equals?: $Enums.ReservationStatus | EnumReservationStatusFieldRefInput<$PrismaModel>
    in?: $Enums.ReservationStatus[] | ListEnumReservationStatusFieldRefInput<$PrismaModel>
    notIn?: $Enums.ReservationStatus[] | ListEnumReservationStatusFieldRefInput<$PrismaModel>
    not?: NestedEnumReservationStatusWithAggregatesFilter<$PrismaModel> | $Enums.ReservationStatus
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedEnumReservationStatusFilter<$PrismaModel>
    _max?: NestedEnumReservationStatusFilter<$PrismaModel>
  }
  export type JsonWithAggregatesFilter<$PrismaModel = never> = 
    | PatchUndefined<
        Either<Required<JsonWithAggregatesFilterBase<$PrismaModel>>, Exclude<keyof Required<JsonWithAggregatesFilterBase<$PrismaModel>>, 'path'>>,
        Required<JsonWithAggregatesFilterBase<$PrismaModel>>
      >
    | OptionalFlat<Omit<Required<JsonWithAggregatesFilterBase<$PrismaModel>>, 'path'>>

  export type JsonWithAggregatesFilterBase<$PrismaModel = never> = {
    equals?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    path?: string[]
    string_contains?: string | StringFieldRefInput<$PrismaModel>
    string_starts_with?: string | StringFieldRefInput<$PrismaModel>
    string_ends_with?: string | StringFieldRefInput<$PrismaModel>
    array_contains?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_starts_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_ends_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    lt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    lte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    not?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedJsonFilter<$PrismaModel>
    _max?: NestedJsonFilter<$PrismaModel>
  }

  export type DateTimeNullableWithAggregatesFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel> | null
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeNullableWithAggregatesFilter<$PrismaModel> | Date | string | null
    _count?: NestedIntNullableFilter<$PrismaModel>
    _min?: NestedDateTimeNullableFilter<$PrismaModel>
    _max?: NestedDateTimeNullableFilter<$PrismaModel>
  }

  export type ReservationRelationFilter = {
    is?: ReservationWhereInput
    isNot?: ReservationWhereInput
  }

  export type TableRelationFilter = {
    is?: TableWhereInput
    isNot?: TableWhereInput
  }

  export type ReservationTableReservationIdTableIdCompoundUniqueInput = {
    reservationId: string
    tableId: string
  }

  export type ReservationTableCountOrderByAggregateInput = {
    reservationId?: SortOrder
    tableId?: SortOrder
  }

  export type ReservationTableMaxOrderByAggregateInput = {
    reservationId?: SortOrder
    tableId?: SortOrder
  }

  export type ReservationTableMinOrderByAggregateInput = {
    reservationId?: SortOrder
    tableId?: SortOrder
  }

  export type WaitlistCountOrderByAggregateInput = {
    id?: SortOrder
    customerId?: SortOrder
    partySize?: SortOrder
    notifiedAt?: SortOrder
    expiresAt?: SortOrder
    createdAt?: SortOrder
    timeSlotId?: SortOrder
  }

  export type WaitlistAvgOrderByAggregateInput = {
    partySize?: SortOrder
  }

  export type WaitlistMaxOrderByAggregateInput = {
    id?: SortOrder
    customerId?: SortOrder
    partySize?: SortOrder
    notifiedAt?: SortOrder
    expiresAt?: SortOrder
    createdAt?: SortOrder
    timeSlotId?: SortOrder
  }

  export type WaitlistMinOrderByAggregateInput = {
    id?: SortOrder
    customerId?: SortOrder
    partySize?: SortOrder
    notifiedAt?: SortOrder
    expiresAt?: SortOrder
    createdAt?: SortOrder
    timeSlotId?: SortOrder
  }

  export type WaitlistSumOrderByAggregateInput = {
    partySize?: SortOrder
  }

  export type StringNullableListFilter<$PrismaModel = never> = {
    equals?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    has?: string | StringFieldRefInput<$PrismaModel> | null
    hasEvery?: string[] | ListStringFieldRefInput<$PrismaModel>
    hasSome?: string[] | ListStringFieldRefInput<$PrismaModel>
    isEmpty?: boolean
  }

  export type StringNullableFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel> | null
    in?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    mode?: QueryMode
    not?: NestedStringNullableFilter<$PrismaModel> | string | null
  }

  export type ReviewCountOrderByAggregateInput = {
    id?: SortOrder
    orderId?: SortOrder
    productIds?: SortOrder
    customerId?: SortOrder
    rating?: SortOrder
    comment?: SortOrder
    channel?: SortOrder
    createdAt?: SortOrder
  }

  export type ReviewAvgOrderByAggregateInput = {
    rating?: SortOrder
  }

  export type ReviewMaxOrderByAggregateInput = {
    id?: SortOrder
    orderId?: SortOrder
    customerId?: SortOrder
    rating?: SortOrder
    comment?: SortOrder
    channel?: SortOrder
    createdAt?: SortOrder
  }

  export type ReviewMinOrderByAggregateInput = {
    id?: SortOrder
    orderId?: SortOrder
    customerId?: SortOrder
    rating?: SortOrder
    comment?: SortOrder
    channel?: SortOrder
    createdAt?: SortOrder
  }

  export type ReviewSumOrderByAggregateInput = {
    rating?: SortOrder
  }

  export type StringNullableWithAggregatesFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel> | null
    in?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    mode?: QueryMode
    not?: NestedStringNullableWithAggregatesFilter<$PrismaModel> | string | null
    _count?: NestedIntNullableFilter<$PrismaModel>
    _min?: NestedStringNullableFilter<$PrismaModel>
    _max?: NestedStringNullableFilter<$PrismaModel>
  }

  export type ReservationTableCreateNestedManyWithoutTableInput = {
    create?: XOR<ReservationTableCreateWithoutTableInput, ReservationTableUncheckedCreateWithoutTableInput> | ReservationTableCreateWithoutTableInput[] | ReservationTableUncheckedCreateWithoutTableInput[]
    connectOrCreate?: ReservationTableCreateOrConnectWithoutTableInput | ReservationTableCreateOrConnectWithoutTableInput[]
    createMany?: ReservationTableCreateManyTableInputEnvelope
    connect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
  }

  export type ReservationTableUncheckedCreateNestedManyWithoutTableInput = {
    create?: XOR<ReservationTableCreateWithoutTableInput, ReservationTableUncheckedCreateWithoutTableInput> | ReservationTableCreateWithoutTableInput[] | ReservationTableUncheckedCreateWithoutTableInput[]
    connectOrCreate?: ReservationTableCreateOrConnectWithoutTableInput | ReservationTableCreateOrConnectWithoutTableInput[]
    createMany?: ReservationTableCreateManyTableInputEnvelope
    connect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
  }

  export type StringFieldUpdateOperationsInput = {
    set?: string
  }

  export type IntFieldUpdateOperationsInput = {
    set?: number
    increment?: number
    decrement?: number
    multiply?: number
    divide?: number
  }

  export type EnumTableLocationFieldUpdateOperationsInput = {
    set?: $Enums.TableLocation
  }

  export type BoolFieldUpdateOperationsInput = {
    set?: boolean
  }

  export type DateTimeFieldUpdateOperationsInput = {
    set?: Date | string
  }

  export type ReservationTableUpdateManyWithoutTableNestedInput = {
    create?: XOR<ReservationTableCreateWithoutTableInput, ReservationTableUncheckedCreateWithoutTableInput> | ReservationTableCreateWithoutTableInput[] | ReservationTableUncheckedCreateWithoutTableInput[]
    connectOrCreate?: ReservationTableCreateOrConnectWithoutTableInput | ReservationTableCreateOrConnectWithoutTableInput[]
    upsert?: ReservationTableUpsertWithWhereUniqueWithoutTableInput | ReservationTableUpsertWithWhereUniqueWithoutTableInput[]
    createMany?: ReservationTableCreateManyTableInputEnvelope
    set?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    disconnect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    delete?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    connect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    update?: ReservationTableUpdateWithWhereUniqueWithoutTableInput | ReservationTableUpdateWithWhereUniqueWithoutTableInput[]
    updateMany?: ReservationTableUpdateManyWithWhereWithoutTableInput | ReservationTableUpdateManyWithWhereWithoutTableInput[]
    deleteMany?: ReservationTableScalarWhereInput | ReservationTableScalarWhereInput[]
  }

  export type ReservationTableUncheckedUpdateManyWithoutTableNestedInput = {
    create?: XOR<ReservationTableCreateWithoutTableInput, ReservationTableUncheckedCreateWithoutTableInput> | ReservationTableCreateWithoutTableInput[] | ReservationTableUncheckedCreateWithoutTableInput[]
    connectOrCreate?: ReservationTableCreateOrConnectWithoutTableInput | ReservationTableCreateOrConnectWithoutTableInput[]
    upsert?: ReservationTableUpsertWithWhereUniqueWithoutTableInput | ReservationTableUpsertWithWhereUniqueWithoutTableInput[]
    createMany?: ReservationTableCreateManyTableInputEnvelope
    set?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    disconnect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    delete?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    connect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    update?: ReservationTableUpdateWithWhereUniqueWithoutTableInput | ReservationTableUpdateWithWhereUniqueWithoutTableInput[]
    updateMany?: ReservationTableUpdateManyWithWhereWithoutTableInput | ReservationTableUpdateManyWithWhereWithoutTableInput[]
    deleteMany?: ReservationTableScalarWhereInput | ReservationTableScalarWhereInput[]
  }

  export type ReservationCreateNestedManyWithoutTimeSlotInput = {
    create?: XOR<ReservationCreateWithoutTimeSlotInput, ReservationUncheckedCreateWithoutTimeSlotInput> | ReservationCreateWithoutTimeSlotInput[] | ReservationUncheckedCreateWithoutTimeSlotInput[]
    connectOrCreate?: ReservationCreateOrConnectWithoutTimeSlotInput | ReservationCreateOrConnectWithoutTimeSlotInput[]
    createMany?: ReservationCreateManyTimeSlotInputEnvelope
    connect?: ReservationWhereUniqueInput | ReservationWhereUniqueInput[]
  }

  export type WaitlistCreateNestedManyWithoutTimeSlotInput = {
    create?: XOR<WaitlistCreateWithoutTimeSlotInput, WaitlistUncheckedCreateWithoutTimeSlotInput> | WaitlistCreateWithoutTimeSlotInput[] | WaitlistUncheckedCreateWithoutTimeSlotInput[]
    connectOrCreate?: WaitlistCreateOrConnectWithoutTimeSlotInput | WaitlistCreateOrConnectWithoutTimeSlotInput[]
    createMany?: WaitlistCreateManyTimeSlotInputEnvelope
    connect?: WaitlistWhereUniqueInput | WaitlistWhereUniqueInput[]
  }

  export type ReservationUncheckedCreateNestedManyWithoutTimeSlotInput = {
    create?: XOR<ReservationCreateWithoutTimeSlotInput, ReservationUncheckedCreateWithoutTimeSlotInput> | ReservationCreateWithoutTimeSlotInput[] | ReservationUncheckedCreateWithoutTimeSlotInput[]
    connectOrCreate?: ReservationCreateOrConnectWithoutTimeSlotInput | ReservationCreateOrConnectWithoutTimeSlotInput[]
    createMany?: ReservationCreateManyTimeSlotInputEnvelope
    connect?: ReservationWhereUniqueInput | ReservationWhereUniqueInput[]
  }

  export type WaitlistUncheckedCreateNestedManyWithoutTimeSlotInput = {
    create?: XOR<WaitlistCreateWithoutTimeSlotInput, WaitlistUncheckedCreateWithoutTimeSlotInput> | WaitlistCreateWithoutTimeSlotInput[] | WaitlistUncheckedCreateWithoutTimeSlotInput[]
    connectOrCreate?: WaitlistCreateOrConnectWithoutTimeSlotInput | WaitlistCreateOrConnectWithoutTimeSlotInput[]
    createMany?: WaitlistCreateManyTimeSlotInputEnvelope
    connect?: WaitlistWhereUniqueInput | WaitlistWhereUniqueInput[]
  }

  export type ReservationUpdateManyWithoutTimeSlotNestedInput = {
    create?: XOR<ReservationCreateWithoutTimeSlotInput, ReservationUncheckedCreateWithoutTimeSlotInput> | ReservationCreateWithoutTimeSlotInput[] | ReservationUncheckedCreateWithoutTimeSlotInput[]
    connectOrCreate?: ReservationCreateOrConnectWithoutTimeSlotInput | ReservationCreateOrConnectWithoutTimeSlotInput[]
    upsert?: ReservationUpsertWithWhereUniqueWithoutTimeSlotInput | ReservationUpsertWithWhereUniqueWithoutTimeSlotInput[]
    createMany?: ReservationCreateManyTimeSlotInputEnvelope
    set?: ReservationWhereUniqueInput | ReservationWhereUniqueInput[]
    disconnect?: ReservationWhereUniqueInput | ReservationWhereUniqueInput[]
    delete?: ReservationWhereUniqueInput | ReservationWhereUniqueInput[]
    connect?: ReservationWhereUniqueInput | ReservationWhereUniqueInput[]
    update?: ReservationUpdateWithWhereUniqueWithoutTimeSlotInput | ReservationUpdateWithWhereUniqueWithoutTimeSlotInput[]
    updateMany?: ReservationUpdateManyWithWhereWithoutTimeSlotInput | ReservationUpdateManyWithWhereWithoutTimeSlotInput[]
    deleteMany?: ReservationScalarWhereInput | ReservationScalarWhereInput[]
  }

  export type WaitlistUpdateManyWithoutTimeSlotNestedInput = {
    create?: XOR<WaitlistCreateWithoutTimeSlotInput, WaitlistUncheckedCreateWithoutTimeSlotInput> | WaitlistCreateWithoutTimeSlotInput[] | WaitlistUncheckedCreateWithoutTimeSlotInput[]
    connectOrCreate?: WaitlistCreateOrConnectWithoutTimeSlotInput | WaitlistCreateOrConnectWithoutTimeSlotInput[]
    upsert?: WaitlistUpsertWithWhereUniqueWithoutTimeSlotInput | WaitlistUpsertWithWhereUniqueWithoutTimeSlotInput[]
    createMany?: WaitlistCreateManyTimeSlotInputEnvelope
    set?: WaitlistWhereUniqueInput | WaitlistWhereUniqueInput[]
    disconnect?: WaitlistWhereUniqueInput | WaitlistWhereUniqueInput[]
    delete?: WaitlistWhereUniqueInput | WaitlistWhereUniqueInput[]
    connect?: WaitlistWhereUniqueInput | WaitlistWhereUniqueInput[]
    update?: WaitlistUpdateWithWhereUniqueWithoutTimeSlotInput | WaitlistUpdateWithWhereUniqueWithoutTimeSlotInput[]
    updateMany?: WaitlistUpdateManyWithWhereWithoutTimeSlotInput | WaitlistUpdateManyWithWhereWithoutTimeSlotInput[]
    deleteMany?: WaitlistScalarWhereInput | WaitlistScalarWhereInput[]
  }

  export type ReservationUncheckedUpdateManyWithoutTimeSlotNestedInput = {
    create?: XOR<ReservationCreateWithoutTimeSlotInput, ReservationUncheckedCreateWithoutTimeSlotInput> | ReservationCreateWithoutTimeSlotInput[] | ReservationUncheckedCreateWithoutTimeSlotInput[]
    connectOrCreate?: ReservationCreateOrConnectWithoutTimeSlotInput | ReservationCreateOrConnectWithoutTimeSlotInput[]
    upsert?: ReservationUpsertWithWhereUniqueWithoutTimeSlotInput | ReservationUpsertWithWhereUniqueWithoutTimeSlotInput[]
    createMany?: ReservationCreateManyTimeSlotInputEnvelope
    set?: ReservationWhereUniqueInput | ReservationWhereUniqueInput[]
    disconnect?: ReservationWhereUniqueInput | ReservationWhereUniqueInput[]
    delete?: ReservationWhereUniqueInput | ReservationWhereUniqueInput[]
    connect?: ReservationWhereUniqueInput | ReservationWhereUniqueInput[]
    update?: ReservationUpdateWithWhereUniqueWithoutTimeSlotInput | ReservationUpdateWithWhereUniqueWithoutTimeSlotInput[]
    updateMany?: ReservationUpdateManyWithWhereWithoutTimeSlotInput | ReservationUpdateManyWithWhereWithoutTimeSlotInput[]
    deleteMany?: ReservationScalarWhereInput | ReservationScalarWhereInput[]
  }

  export type WaitlistUncheckedUpdateManyWithoutTimeSlotNestedInput = {
    create?: XOR<WaitlistCreateWithoutTimeSlotInput, WaitlistUncheckedCreateWithoutTimeSlotInput> | WaitlistCreateWithoutTimeSlotInput[] | WaitlistUncheckedCreateWithoutTimeSlotInput[]
    connectOrCreate?: WaitlistCreateOrConnectWithoutTimeSlotInput | WaitlistCreateOrConnectWithoutTimeSlotInput[]
    upsert?: WaitlistUpsertWithWhereUniqueWithoutTimeSlotInput | WaitlistUpsertWithWhereUniqueWithoutTimeSlotInput[]
    createMany?: WaitlistCreateManyTimeSlotInputEnvelope
    set?: WaitlistWhereUniqueInput | WaitlistWhereUniqueInput[]
    disconnect?: WaitlistWhereUniqueInput | WaitlistWhereUniqueInput[]
    delete?: WaitlistWhereUniqueInput | WaitlistWhereUniqueInput[]
    connect?: WaitlistWhereUniqueInput | WaitlistWhereUniqueInput[]
    update?: WaitlistUpdateWithWhereUniqueWithoutTimeSlotInput | WaitlistUpdateWithWhereUniqueWithoutTimeSlotInput[]
    updateMany?: WaitlistUpdateManyWithWhereWithoutTimeSlotInput | WaitlistUpdateManyWithWhereWithoutTimeSlotInput[]
    deleteMany?: WaitlistScalarWhereInput | WaitlistScalarWhereInput[]
  }

  export type TimeSlotCreateNestedOneWithoutReservationsInput = {
    create?: XOR<TimeSlotCreateWithoutReservationsInput, TimeSlotUncheckedCreateWithoutReservationsInput>
    connectOrCreate?: TimeSlotCreateOrConnectWithoutReservationsInput
    connect?: TimeSlotWhereUniqueInput
  }

  export type ReservationTableCreateNestedManyWithoutReservationInput = {
    create?: XOR<ReservationTableCreateWithoutReservationInput, ReservationTableUncheckedCreateWithoutReservationInput> | ReservationTableCreateWithoutReservationInput[] | ReservationTableUncheckedCreateWithoutReservationInput[]
    connectOrCreate?: ReservationTableCreateOrConnectWithoutReservationInput | ReservationTableCreateOrConnectWithoutReservationInput[]
    createMany?: ReservationTableCreateManyReservationInputEnvelope
    connect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
  }

  export type ReservationTableUncheckedCreateNestedManyWithoutReservationInput = {
    create?: XOR<ReservationTableCreateWithoutReservationInput, ReservationTableUncheckedCreateWithoutReservationInput> | ReservationTableCreateWithoutReservationInput[] | ReservationTableUncheckedCreateWithoutReservationInput[]
    connectOrCreate?: ReservationTableCreateOrConnectWithoutReservationInput | ReservationTableCreateOrConnectWithoutReservationInput[]
    createMany?: ReservationTableCreateManyReservationInputEnvelope
    connect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
  }

  export type EnumReservationStatusFieldUpdateOperationsInput = {
    set?: $Enums.ReservationStatus
  }

  export type NullableDateTimeFieldUpdateOperationsInput = {
    set?: Date | string | null
  }

  export type TimeSlotUpdateOneRequiredWithoutReservationsNestedInput = {
    create?: XOR<TimeSlotCreateWithoutReservationsInput, TimeSlotUncheckedCreateWithoutReservationsInput>
    connectOrCreate?: TimeSlotCreateOrConnectWithoutReservationsInput
    upsert?: TimeSlotUpsertWithoutReservationsInput
    connect?: TimeSlotWhereUniqueInput
    update?: XOR<XOR<TimeSlotUpdateToOneWithWhereWithoutReservationsInput, TimeSlotUpdateWithoutReservationsInput>, TimeSlotUncheckedUpdateWithoutReservationsInput>
  }

  export type ReservationTableUpdateManyWithoutReservationNestedInput = {
    create?: XOR<ReservationTableCreateWithoutReservationInput, ReservationTableUncheckedCreateWithoutReservationInput> | ReservationTableCreateWithoutReservationInput[] | ReservationTableUncheckedCreateWithoutReservationInput[]
    connectOrCreate?: ReservationTableCreateOrConnectWithoutReservationInput | ReservationTableCreateOrConnectWithoutReservationInput[]
    upsert?: ReservationTableUpsertWithWhereUniqueWithoutReservationInput | ReservationTableUpsertWithWhereUniqueWithoutReservationInput[]
    createMany?: ReservationTableCreateManyReservationInputEnvelope
    set?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    disconnect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    delete?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    connect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    update?: ReservationTableUpdateWithWhereUniqueWithoutReservationInput | ReservationTableUpdateWithWhereUniqueWithoutReservationInput[]
    updateMany?: ReservationTableUpdateManyWithWhereWithoutReservationInput | ReservationTableUpdateManyWithWhereWithoutReservationInput[]
    deleteMany?: ReservationTableScalarWhereInput | ReservationTableScalarWhereInput[]
  }

  export type ReservationTableUncheckedUpdateManyWithoutReservationNestedInput = {
    create?: XOR<ReservationTableCreateWithoutReservationInput, ReservationTableUncheckedCreateWithoutReservationInput> | ReservationTableCreateWithoutReservationInput[] | ReservationTableUncheckedCreateWithoutReservationInput[]
    connectOrCreate?: ReservationTableCreateOrConnectWithoutReservationInput | ReservationTableCreateOrConnectWithoutReservationInput[]
    upsert?: ReservationTableUpsertWithWhereUniqueWithoutReservationInput | ReservationTableUpsertWithWhereUniqueWithoutReservationInput[]
    createMany?: ReservationTableCreateManyReservationInputEnvelope
    set?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    disconnect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    delete?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    connect?: ReservationTableWhereUniqueInput | ReservationTableWhereUniqueInput[]
    update?: ReservationTableUpdateWithWhereUniqueWithoutReservationInput | ReservationTableUpdateWithWhereUniqueWithoutReservationInput[]
    updateMany?: ReservationTableUpdateManyWithWhereWithoutReservationInput | ReservationTableUpdateManyWithWhereWithoutReservationInput[]
    deleteMany?: ReservationTableScalarWhereInput | ReservationTableScalarWhereInput[]
  }

  export type ReservationCreateNestedOneWithoutTablesInput = {
    create?: XOR<ReservationCreateWithoutTablesInput, ReservationUncheckedCreateWithoutTablesInput>
    connectOrCreate?: ReservationCreateOrConnectWithoutTablesInput
    connect?: ReservationWhereUniqueInput
  }

  export type TableCreateNestedOneWithoutReservationTablesInput = {
    create?: XOR<TableCreateWithoutReservationTablesInput, TableUncheckedCreateWithoutReservationTablesInput>
    connectOrCreate?: TableCreateOrConnectWithoutReservationTablesInput
    connect?: TableWhereUniqueInput
  }

  export type ReservationUpdateOneRequiredWithoutTablesNestedInput = {
    create?: XOR<ReservationCreateWithoutTablesInput, ReservationUncheckedCreateWithoutTablesInput>
    connectOrCreate?: ReservationCreateOrConnectWithoutTablesInput
    upsert?: ReservationUpsertWithoutTablesInput
    connect?: ReservationWhereUniqueInput
    update?: XOR<XOR<ReservationUpdateToOneWithWhereWithoutTablesInput, ReservationUpdateWithoutTablesInput>, ReservationUncheckedUpdateWithoutTablesInput>
  }

  export type TableUpdateOneRequiredWithoutReservationTablesNestedInput = {
    create?: XOR<TableCreateWithoutReservationTablesInput, TableUncheckedCreateWithoutReservationTablesInput>
    connectOrCreate?: TableCreateOrConnectWithoutReservationTablesInput
    upsert?: TableUpsertWithoutReservationTablesInput
    connect?: TableWhereUniqueInput
    update?: XOR<XOR<TableUpdateToOneWithWhereWithoutReservationTablesInput, TableUpdateWithoutReservationTablesInput>, TableUncheckedUpdateWithoutReservationTablesInput>
  }

  export type TimeSlotCreateNestedOneWithoutWaitlistInput = {
    create?: XOR<TimeSlotCreateWithoutWaitlistInput, TimeSlotUncheckedCreateWithoutWaitlistInput>
    connectOrCreate?: TimeSlotCreateOrConnectWithoutWaitlistInput
    connect?: TimeSlotWhereUniqueInput
  }

  export type TimeSlotUpdateOneRequiredWithoutWaitlistNestedInput = {
    create?: XOR<TimeSlotCreateWithoutWaitlistInput, TimeSlotUncheckedCreateWithoutWaitlistInput>
    connectOrCreate?: TimeSlotCreateOrConnectWithoutWaitlistInput
    upsert?: TimeSlotUpsertWithoutWaitlistInput
    connect?: TimeSlotWhereUniqueInput
    update?: XOR<XOR<TimeSlotUpdateToOneWithWhereWithoutWaitlistInput, TimeSlotUpdateWithoutWaitlistInput>, TimeSlotUncheckedUpdateWithoutWaitlistInput>
  }

  export type ReviewCreateproductIdsInput = {
    set: string[]
  }

  export type ReviewUpdateproductIdsInput = {
    set?: string[]
    push?: string | string[]
  }

  export type NullableStringFieldUpdateOperationsInput = {
    set?: string | null
  }

  export type NestedStringFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    not?: NestedStringFilter<$PrismaModel> | string
  }

  export type NestedIntFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntFilter<$PrismaModel> | number
  }

  export type NestedEnumTableLocationFilter<$PrismaModel = never> = {
    equals?: $Enums.TableLocation | EnumTableLocationFieldRefInput<$PrismaModel>
    in?: $Enums.TableLocation[] | ListEnumTableLocationFieldRefInput<$PrismaModel>
    notIn?: $Enums.TableLocation[] | ListEnumTableLocationFieldRefInput<$PrismaModel>
    not?: NestedEnumTableLocationFilter<$PrismaModel> | $Enums.TableLocation
  }

  export type NestedBoolFilter<$PrismaModel = never> = {
    equals?: boolean | BooleanFieldRefInput<$PrismaModel>
    not?: NestedBoolFilter<$PrismaModel> | boolean
  }

  export type NestedDateTimeFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeFilter<$PrismaModel> | Date | string
  }

  export type NestedStringWithAggregatesFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    not?: NestedStringWithAggregatesFilter<$PrismaModel> | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedStringFilter<$PrismaModel>
    _max?: NestedStringFilter<$PrismaModel>
  }

  export type NestedIntWithAggregatesFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntWithAggregatesFilter<$PrismaModel> | number
    _count?: NestedIntFilter<$PrismaModel>
    _avg?: NestedFloatFilter<$PrismaModel>
    _sum?: NestedIntFilter<$PrismaModel>
    _min?: NestedIntFilter<$PrismaModel>
    _max?: NestedIntFilter<$PrismaModel>
  }

  export type NestedFloatFilter<$PrismaModel = never> = {
    equals?: number | FloatFieldRefInput<$PrismaModel>
    in?: number[] | ListFloatFieldRefInput<$PrismaModel>
    notIn?: number[] | ListFloatFieldRefInput<$PrismaModel>
    lt?: number | FloatFieldRefInput<$PrismaModel>
    lte?: number | FloatFieldRefInput<$PrismaModel>
    gt?: number | FloatFieldRefInput<$PrismaModel>
    gte?: number | FloatFieldRefInput<$PrismaModel>
    not?: NestedFloatFilter<$PrismaModel> | number
  }

  export type NestedEnumTableLocationWithAggregatesFilter<$PrismaModel = never> = {
    equals?: $Enums.TableLocation | EnumTableLocationFieldRefInput<$PrismaModel>
    in?: $Enums.TableLocation[] | ListEnumTableLocationFieldRefInput<$PrismaModel>
    notIn?: $Enums.TableLocation[] | ListEnumTableLocationFieldRefInput<$PrismaModel>
    not?: NestedEnumTableLocationWithAggregatesFilter<$PrismaModel> | $Enums.TableLocation
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedEnumTableLocationFilter<$PrismaModel>
    _max?: NestedEnumTableLocationFilter<$PrismaModel>
  }

  export type NestedBoolWithAggregatesFilter<$PrismaModel = never> = {
    equals?: boolean | BooleanFieldRefInput<$PrismaModel>
    not?: NestedBoolWithAggregatesFilter<$PrismaModel> | boolean
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedBoolFilter<$PrismaModel>
    _max?: NestedBoolFilter<$PrismaModel>
  }

  export type NestedDateTimeWithAggregatesFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeWithAggregatesFilter<$PrismaModel> | Date | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedDateTimeFilter<$PrismaModel>
    _max?: NestedDateTimeFilter<$PrismaModel>
  }

  export type NestedEnumReservationStatusFilter<$PrismaModel = never> = {
    equals?: $Enums.ReservationStatus | EnumReservationStatusFieldRefInput<$PrismaModel>
    in?: $Enums.ReservationStatus[] | ListEnumReservationStatusFieldRefInput<$PrismaModel>
    notIn?: $Enums.ReservationStatus[] | ListEnumReservationStatusFieldRefInput<$PrismaModel>
    not?: NestedEnumReservationStatusFilter<$PrismaModel> | $Enums.ReservationStatus
  }

  export type NestedDateTimeNullableFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel> | null
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeNullableFilter<$PrismaModel> | Date | string | null
  }

  export type NestedEnumReservationStatusWithAggregatesFilter<$PrismaModel = never> = {
    equals?: $Enums.ReservationStatus | EnumReservationStatusFieldRefInput<$PrismaModel>
    in?: $Enums.ReservationStatus[] | ListEnumReservationStatusFieldRefInput<$PrismaModel>
    notIn?: $Enums.ReservationStatus[] | ListEnumReservationStatusFieldRefInput<$PrismaModel>
    not?: NestedEnumReservationStatusWithAggregatesFilter<$PrismaModel> | $Enums.ReservationStatus
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedEnumReservationStatusFilter<$PrismaModel>
    _max?: NestedEnumReservationStatusFilter<$PrismaModel>
  }
  export type NestedJsonFilter<$PrismaModel = never> = 
    | PatchUndefined<
        Either<Required<NestedJsonFilterBase<$PrismaModel>>, Exclude<keyof Required<NestedJsonFilterBase<$PrismaModel>>, 'path'>>,
        Required<NestedJsonFilterBase<$PrismaModel>>
      >
    | OptionalFlat<Omit<Required<NestedJsonFilterBase<$PrismaModel>>, 'path'>>

  export type NestedJsonFilterBase<$PrismaModel = never> = {
    equals?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    path?: string[]
    string_contains?: string | StringFieldRefInput<$PrismaModel>
    string_starts_with?: string | StringFieldRefInput<$PrismaModel>
    string_ends_with?: string | StringFieldRefInput<$PrismaModel>
    array_contains?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_starts_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_ends_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    lt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    lte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    not?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
  }

  export type NestedDateTimeNullableWithAggregatesFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel> | null
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeNullableWithAggregatesFilter<$PrismaModel> | Date | string | null
    _count?: NestedIntNullableFilter<$PrismaModel>
    _min?: NestedDateTimeNullableFilter<$PrismaModel>
    _max?: NestedDateTimeNullableFilter<$PrismaModel>
  }

  export type NestedIntNullableFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel> | null
    in?: number[] | ListIntFieldRefInput<$PrismaModel> | null
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel> | null
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntNullableFilter<$PrismaModel> | number | null
  }

  export type NestedStringNullableFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel> | null
    in?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    not?: NestedStringNullableFilter<$PrismaModel> | string | null
  }

  export type NestedStringNullableWithAggregatesFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel> | null
    in?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    not?: NestedStringNullableWithAggregatesFilter<$PrismaModel> | string | null
    _count?: NestedIntNullableFilter<$PrismaModel>
    _min?: NestedStringNullableFilter<$PrismaModel>
    _max?: NestedStringNullableFilter<$PrismaModel>
  }

  export type ReservationTableCreateWithoutTableInput = {
    reservation: ReservationCreateNestedOneWithoutTablesInput
  }

  export type ReservationTableUncheckedCreateWithoutTableInput = {
    reservationId: string
  }

  export type ReservationTableCreateOrConnectWithoutTableInput = {
    where: ReservationTableWhereUniqueInput
    create: XOR<ReservationTableCreateWithoutTableInput, ReservationTableUncheckedCreateWithoutTableInput>
  }

  export type ReservationTableCreateManyTableInputEnvelope = {
    data: ReservationTableCreateManyTableInput | ReservationTableCreateManyTableInput[]
    skipDuplicates?: boolean
  }

  export type ReservationTableUpsertWithWhereUniqueWithoutTableInput = {
    where: ReservationTableWhereUniqueInput
    update: XOR<ReservationTableUpdateWithoutTableInput, ReservationTableUncheckedUpdateWithoutTableInput>
    create: XOR<ReservationTableCreateWithoutTableInput, ReservationTableUncheckedCreateWithoutTableInput>
  }

  export type ReservationTableUpdateWithWhereUniqueWithoutTableInput = {
    where: ReservationTableWhereUniqueInput
    data: XOR<ReservationTableUpdateWithoutTableInput, ReservationTableUncheckedUpdateWithoutTableInput>
  }

  export type ReservationTableUpdateManyWithWhereWithoutTableInput = {
    where: ReservationTableScalarWhereInput
    data: XOR<ReservationTableUpdateManyMutationInput, ReservationTableUncheckedUpdateManyWithoutTableInput>
  }

  export type ReservationTableScalarWhereInput = {
    AND?: ReservationTableScalarWhereInput | ReservationTableScalarWhereInput[]
    OR?: ReservationTableScalarWhereInput[]
    NOT?: ReservationTableScalarWhereInput | ReservationTableScalarWhereInput[]
    reservationId?: StringFilter<"ReservationTable"> | string
    tableId?: StringFilter<"ReservationTable"> | string
  }

  export type ReservationCreateWithoutTimeSlotInput = {
    id?: string
    customerId: string
    partySize: number
    status?: $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: Date | string | null
    checkedInAt?: Date | string | null
    cancelledAt?: Date | string | null
    createdAt?: Date | string
    updatedAt?: Date | string
    tables?: ReservationTableCreateNestedManyWithoutReservationInput
  }

  export type ReservationUncheckedCreateWithoutTimeSlotInput = {
    id?: string
    customerId: string
    partySize: number
    status?: $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: Date | string | null
    checkedInAt?: Date | string | null
    cancelledAt?: Date | string | null
    createdAt?: Date | string
    updatedAt?: Date | string
    tables?: ReservationTableUncheckedCreateNestedManyWithoutReservationInput
  }

  export type ReservationCreateOrConnectWithoutTimeSlotInput = {
    where: ReservationWhereUniqueInput
    create: XOR<ReservationCreateWithoutTimeSlotInput, ReservationUncheckedCreateWithoutTimeSlotInput>
  }

  export type ReservationCreateManyTimeSlotInputEnvelope = {
    data: ReservationCreateManyTimeSlotInput | ReservationCreateManyTimeSlotInput[]
    skipDuplicates?: boolean
  }

  export type WaitlistCreateWithoutTimeSlotInput = {
    id?: string
    customerId: string
    partySize: number
    notifiedAt?: Date | string | null
    expiresAt: Date | string
    createdAt?: Date | string
  }

  export type WaitlistUncheckedCreateWithoutTimeSlotInput = {
    id?: string
    customerId: string
    partySize: number
    notifiedAt?: Date | string | null
    expiresAt: Date | string
    createdAt?: Date | string
  }

  export type WaitlistCreateOrConnectWithoutTimeSlotInput = {
    where: WaitlistWhereUniqueInput
    create: XOR<WaitlistCreateWithoutTimeSlotInput, WaitlistUncheckedCreateWithoutTimeSlotInput>
  }

  export type WaitlistCreateManyTimeSlotInputEnvelope = {
    data: WaitlistCreateManyTimeSlotInput | WaitlistCreateManyTimeSlotInput[]
    skipDuplicates?: boolean
  }

  export type ReservationUpsertWithWhereUniqueWithoutTimeSlotInput = {
    where: ReservationWhereUniqueInput
    update: XOR<ReservationUpdateWithoutTimeSlotInput, ReservationUncheckedUpdateWithoutTimeSlotInput>
    create: XOR<ReservationCreateWithoutTimeSlotInput, ReservationUncheckedCreateWithoutTimeSlotInput>
  }

  export type ReservationUpdateWithWhereUniqueWithoutTimeSlotInput = {
    where: ReservationWhereUniqueInput
    data: XOR<ReservationUpdateWithoutTimeSlotInput, ReservationUncheckedUpdateWithoutTimeSlotInput>
  }

  export type ReservationUpdateManyWithWhereWithoutTimeSlotInput = {
    where: ReservationScalarWhereInput
    data: XOR<ReservationUpdateManyMutationInput, ReservationUncheckedUpdateManyWithoutTimeSlotInput>
  }

  export type ReservationScalarWhereInput = {
    AND?: ReservationScalarWhereInput | ReservationScalarWhereInput[]
    OR?: ReservationScalarWhereInput[]
    NOT?: ReservationScalarWhereInput | ReservationScalarWhereInput[]
    id?: StringFilter<"Reservation"> | string
    customerId?: StringFilter<"Reservation"> | string
    partySize?: IntFilter<"Reservation"> | number
    status?: EnumReservationStatusFilter<"Reservation"> | $Enums.ReservationStatus
    specialRequests?: JsonFilter<"Reservation">
    confirmedAt?: DateTimeNullableFilter<"Reservation"> | Date | string | null
    checkedInAt?: DateTimeNullableFilter<"Reservation"> | Date | string | null
    cancelledAt?: DateTimeNullableFilter<"Reservation"> | Date | string | null
    createdAt?: DateTimeFilter<"Reservation"> | Date | string
    updatedAt?: DateTimeFilter<"Reservation"> | Date | string
    timeSlotId?: StringFilter<"Reservation"> | string
  }

  export type WaitlistUpsertWithWhereUniqueWithoutTimeSlotInput = {
    where: WaitlistWhereUniqueInput
    update: XOR<WaitlistUpdateWithoutTimeSlotInput, WaitlistUncheckedUpdateWithoutTimeSlotInput>
    create: XOR<WaitlistCreateWithoutTimeSlotInput, WaitlistUncheckedCreateWithoutTimeSlotInput>
  }

  export type WaitlistUpdateWithWhereUniqueWithoutTimeSlotInput = {
    where: WaitlistWhereUniqueInput
    data: XOR<WaitlistUpdateWithoutTimeSlotInput, WaitlistUncheckedUpdateWithoutTimeSlotInput>
  }

  export type WaitlistUpdateManyWithWhereWithoutTimeSlotInput = {
    where: WaitlistScalarWhereInput
    data: XOR<WaitlistUpdateManyMutationInput, WaitlistUncheckedUpdateManyWithoutTimeSlotInput>
  }

  export type WaitlistScalarWhereInput = {
    AND?: WaitlistScalarWhereInput | WaitlistScalarWhereInput[]
    OR?: WaitlistScalarWhereInput[]
    NOT?: WaitlistScalarWhereInput | WaitlistScalarWhereInput[]
    id?: StringFilter<"Waitlist"> | string
    customerId?: StringFilter<"Waitlist"> | string
    partySize?: IntFilter<"Waitlist"> | number
    notifiedAt?: DateTimeNullableFilter<"Waitlist"> | Date | string | null
    expiresAt?: DateTimeFilter<"Waitlist"> | Date | string
    createdAt?: DateTimeFilter<"Waitlist"> | Date | string
    timeSlotId?: StringFilter<"Waitlist"> | string
  }

  export type TimeSlotCreateWithoutReservationsInput = {
    id?: string
    date: Date | string
    startTime: string
    durationMinutes?: number
    maxCovers: number
    reservedCovers?: number
    createdAt?: Date | string
    waitlist?: WaitlistCreateNestedManyWithoutTimeSlotInput
  }

  export type TimeSlotUncheckedCreateWithoutReservationsInput = {
    id?: string
    date: Date | string
    startTime: string
    durationMinutes?: number
    maxCovers: number
    reservedCovers?: number
    createdAt?: Date | string
    waitlist?: WaitlistUncheckedCreateNestedManyWithoutTimeSlotInput
  }

  export type TimeSlotCreateOrConnectWithoutReservationsInput = {
    where: TimeSlotWhereUniqueInput
    create: XOR<TimeSlotCreateWithoutReservationsInput, TimeSlotUncheckedCreateWithoutReservationsInput>
  }

  export type ReservationTableCreateWithoutReservationInput = {
    table: TableCreateNestedOneWithoutReservationTablesInput
  }

  export type ReservationTableUncheckedCreateWithoutReservationInput = {
    tableId: string
  }

  export type ReservationTableCreateOrConnectWithoutReservationInput = {
    where: ReservationTableWhereUniqueInput
    create: XOR<ReservationTableCreateWithoutReservationInput, ReservationTableUncheckedCreateWithoutReservationInput>
  }

  export type ReservationTableCreateManyReservationInputEnvelope = {
    data: ReservationTableCreateManyReservationInput | ReservationTableCreateManyReservationInput[]
    skipDuplicates?: boolean
  }

  export type TimeSlotUpsertWithoutReservationsInput = {
    update: XOR<TimeSlotUpdateWithoutReservationsInput, TimeSlotUncheckedUpdateWithoutReservationsInput>
    create: XOR<TimeSlotCreateWithoutReservationsInput, TimeSlotUncheckedCreateWithoutReservationsInput>
    where?: TimeSlotWhereInput
  }

  export type TimeSlotUpdateToOneWithWhereWithoutReservationsInput = {
    where?: TimeSlotWhereInput
    data: XOR<TimeSlotUpdateWithoutReservationsInput, TimeSlotUncheckedUpdateWithoutReservationsInput>
  }

  export type TimeSlotUpdateWithoutReservationsInput = {
    id?: StringFieldUpdateOperationsInput | string
    date?: DateTimeFieldUpdateOperationsInput | Date | string
    startTime?: StringFieldUpdateOperationsInput | string
    durationMinutes?: IntFieldUpdateOperationsInput | number
    maxCovers?: IntFieldUpdateOperationsInput | number
    reservedCovers?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    waitlist?: WaitlistUpdateManyWithoutTimeSlotNestedInput
  }

  export type TimeSlotUncheckedUpdateWithoutReservationsInput = {
    id?: StringFieldUpdateOperationsInput | string
    date?: DateTimeFieldUpdateOperationsInput | Date | string
    startTime?: StringFieldUpdateOperationsInput | string
    durationMinutes?: IntFieldUpdateOperationsInput | number
    maxCovers?: IntFieldUpdateOperationsInput | number
    reservedCovers?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    waitlist?: WaitlistUncheckedUpdateManyWithoutTimeSlotNestedInput
  }

  export type ReservationTableUpsertWithWhereUniqueWithoutReservationInput = {
    where: ReservationTableWhereUniqueInput
    update: XOR<ReservationTableUpdateWithoutReservationInput, ReservationTableUncheckedUpdateWithoutReservationInput>
    create: XOR<ReservationTableCreateWithoutReservationInput, ReservationTableUncheckedCreateWithoutReservationInput>
  }

  export type ReservationTableUpdateWithWhereUniqueWithoutReservationInput = {
    where: ReservationTableWhereUniqueInput
    data: XOR<ReservationTableUpdateWithoutReservationInput, ReservationTableUncheckedUpdateWithoutReservationInput>
  }

  export type ReservationTableUpdateManyWithWhereWithoutReservationInput = {
    where: ReservationTableScalarWhereInput
    data: XOR<ReservationTableUpdateManyMutationInput, ReservationTableUncheckedUpdateManyWithoutReservationInput>
  }

  export type ReservationCreateWithoutTablesInput = {
    id?: string
    customerId: string
    partySize: number
    status?: $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: Date | string | null
    checkedInAt?: Date | string | null
    cancelledAt?: Date | string | null
    createdAt?: Date | string
    updatedAt?: Date | string
    timeSlot: TimeSlotCreateNestedOneWithoutReservationsInput
  }

  export type ReservationUncheckedCreateWithoutTablesInput = {
    id?: string
    customerId: string
    partySize: number
    status?: $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: Date | string | null
    checkedInAt?: Date | string | null
    cancelledAt?: Date | string | null
    createdAt?: Date | string
    updatedAt?: Date | string
    timeSlotId: string
  }

  export type ReservationCreateOrConnectWithoutTablesInput = {
    where: ReservationWhereUniqueInput
    create: XOR<ReservationCreateWithoutTablesInput, ReservationUncheckedCreateWithoutTablesInput>
  }

  export type TableCreateWithoutReservationTablesInput = {
    id?: string
    number: string
    capacity: number
    location: $Enums.TableLocation
    accessible?: boolean
    active?: boolean
    createdAt?: Date | string
  }

  export type TableUncheckedCreateWithoutReservationTablesInput = {
    id?: string
    number: string
    capacity: number
    location: $Enums.TableLocation
    accessible?: boolean
    active?: boolean
    createdAt?: Date | string
  }

  export type TableCreateOrConnectWithoutReservationTablesInput = {
    where: TableWhereUniqueInput
    create: XOR<TableCreateWithoutReservationTablesInput, TableUncheckedCreateWithoutReservationTablesInput>
  }

  export type ReservationUpsertWithoutTablesInput = {
    update: XOR<ReservationUpdateWithoutTablesInput, ReservationUncheckedUpdateWithoutTablesInput>
    create: XOR<ReservationCreateWithoutTablesInput, ReservationUncheckedCreateWithoutTablesInput>
    where?: ReservationWhereInput
  }

  export type ReservationUpdateToOneWithWhereWithoutTablesInput = {
    where?: ReservationWhereInput
    data: XOR<ReservationUpdateWithoutTablesInput, ReservationUncheckedUpdateWithoutTablesInput>
  }

  export type ReservationUpdateWithoutTablesInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    status?: EnumReservationStatusFieldUpdateOperationsInput | $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    checkedInAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    cancelledAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    timeSlot?: TimeSlotUpdateOneRequiredWithoutReservationsNestedInput
  }

  export type ReservationUncheckedUpdateWithoutTablesInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    status?: EnumReservationStatusFieldUpdateOperationsInput | $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    checkedInAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    cancelledAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    timeSlotId?: StringFieldUpdateOperationsInput | string
  }

  export type TableUpsertWithoutReservationTablesInput = {
    update: XOR<TableUpdateWithoutReservationTablesInput, TableUncheckedUpdateWithoutReservationTablesInput>
    create: XOR<TableCreateWithoutReservationTablesInput, TableUncheckedCreateWithoutReservationTablesInput>
    where?: TableWhereInput
  }

  export type TableUpdateToOneWithWhereWithoutReservationTablesInput = {
    where?: TableWhereInput
    data: XOR<TableUpdateWithoutReservationTablesInput, TableUncheckedUpdateWithoutReservationTablesInput>
  }

  export type TableUpdateWithoutReservationTablesInput = {
    id?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    capacity?: IntFieldUpdateOperationsInput | number
    location?: EnumTableLocationFieldUpdateOperationsInput | $Enums.TableLocation
    accessible?: BoolFieldUpdateOperationsInput | boolean
    active?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type TableUncheckedUpdateWithoutReservationTablesInput = {
    id?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    capacity?: IntFieldUpdateOperationsInput | number
    location?: EnumTableLocationFieldUpdateOperationsInput | $Enums.TableLocation
    accessible?: BoolFieldUpdateOperationsInput | boolean
    active?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type TimeSlotCreateWithoutWaitlistInput = {
    id?: string
    date: Date | string
    startTime: string
    durationMinutes?: number
    maxCovers: number
    reservedCovers?: number
    createdAt?: Date | string
    reservations?: ReservationCreateNestedManyWithoutTimeSlotInput
  }

  export type TimeSlotUncheckedCreateWithoutWaitlistInput = {
    id?: string
    date: Date | string
    startTime: string
    durationMinutes?: number
    maxCovers: number
    reservedCovers?: number
    createdAt?: Date | string
    reservations?: ReservationUncheckedCreateNestedManyWithoutTimeSlotInput
  }

  export type TimeSlotCreateOrConnectWithoutWaitlistInput = {
    where: TimeSlotWhereUniqueInput
    create: XOR<TimeSlotCreateWithoutWaitlistInput, TimeSlotUncheckedCreateWithoutWaitlistInput>
  }

  export type TimeSlotUpsertWithoutWaitlistInput = {
    update: XOR<TimeSlotUpdateWithoutWaitlistInput, TimeSlotUncheckedUpdateWithoutWaitlistInput>
    create: XOR<TimeSlotCreateWithoutWaitlistInput, TimeSlotUncheckedCreateWithoutWaitlistInput>
    where?: TimeSlotWhereInput
  }

  export type TimeSlotUpdateToOneWithWhereWithoutWaitlistInput = {
    where?: TimeSlotWhereInput
    data: XOR<TimeSlotUpdateWithoutWaitlistInput, TimeSlotUncheckedUpdateWithoutWaitlistInput>
  }

  export type TimeSlotUpdateWithoutWaitlistInput = {
    id?: StringFieldUpdateOperationsInput | string
    date?: DateTimeFieldUpdateOperationsInput | Date | string
    startTime?: StringFieldUpdateOperationsInput | string
    durationMinutes?: IntFieldUpdateOperationsInput | number
    maxCovers?: IntFieldUpdateOperationsInput | number
    reservedCovers?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    reservations?: ReservationUpdateManyWithoutTimeSlotNestedInput
  }

  export type TimeSlotUncheckedUpdateWithoutWaitlistInput = {
    id?: StringFieldUpdateOperationsInput | string
    date?: DateTimeFieldUpdateOperationsInput | Date | string
    startTime?: StringFieldUpdateOperationsInput | string
    durationMinutes?: IntFieldUpdateOperationsInput | number
    maxCovers?: IntFieldUpdateOperationsInput | number
    reservedCovers?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    reservations?: ReservationUncheckedUpdateManyWithoutTimeSlotNestedInput
  }

  export type ReservationTableCreateManyTableInput = {
    reservationId: string
  }

  export type ReservationTableUpdateWithoutTableInput = {
    reservation?: ReservationUpdateOneRequiredWithoutTablesNestedInput
  }

  export type ReservationTableUncheckedUpdateWithoutTableInput = {
    reservationId?: StringFieldUpdateOperationsInput | string
  }

  export type ReservationTableUncheckedUpdateManyWithoutTableInput = {
    reservationId?: StringFieldUpdateOperationsInput | string
  }

  export type ReservationCreateManyTimeSlotInput = {
    id?: string
    customerId: string
    partySize: number
    status?: $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: Date | string | null
    checkedInAt?: Date | string | null
    cancelledAt?: Date | string | null
    createdAt?: Date | string
    updatedAt?: Date | string
  }

  export type WaitlistCreateManyTimeSlotInput = {
    id?: string
    customerId: string
    partySize: number
    notifiedAt?: Date | string | null
    expiresAt: Date | string
    createdAt?: Date | string
  }

  export type ReservationUpdateWithoutTimeSlotInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    status?: EnumReservationStatusFieldUpdateOperationsInput | $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    checkedInAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    cancelledAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    tables?: ReservationTableUpdateManyWithoutReservationNestedInput
  }

  export type ReservationUncheckedUpdateWithoutTimeSlotInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    status?: EnumReservationStatusFieldUpdateOperationsInput | $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    checkedInAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    cancelledAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    tables?: ReservationTableUncheckedUpdateManyWithoutReservationNestedInput
  }

  export type ReservationUncheckedUpdateManyWithoutTimeSlotInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    status?: EnumReservationStatusFieldUpdateOperationsInput | $Enums.ReservationStatus
    specialRequests?: JsonNullValueInput | InputJsonValue
    confirmedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    checkedInAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    cancelledAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type WaitlistUpdateWithoutTimeSlotInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    notifiedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    expiresAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type WaitlistUncheckedUpdateWithoutTimeSlotInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    notifiedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    expiresAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type WaitlistUncheckedUpdateManyWithoutTimeSlotInput = {
    id?: StringFieldUpdateOperationsInput | string
    customerId?: StringFieldUpdateOperationsInput | string
    partySize?: IntFieldUpdateOperationsInput | number
    notifiedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    expiresAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type ReservationTableCreateManyReservationInput = {
    tableId: string
  }

  export type ReservationTableUpdateWithoutReservationInput = {
    table?: TableUpdateOneRequiredWithoutReservationTablesNestedInput
  }

  export type ReservationTableUncheckedUpdateWithoutReservationInput = {
    tableId?: StringFieldUpdateOperationsInput | string
  }

  export type ReservationTableUncheckedUpdateManyWithoutReservationInput = {
    tableId?: StringFieldUpdateOperationsInput | string
  }



  /**
   * Aliases for legacy arg types
   */
    /**
     * @deprecated Use TableCountOutputTypeDefaultArgs instead
     */
    export type TableCountOutputTypeArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = TableCountOutputTypeDefaultArgs<ExtArgs>
    /**
     * @deprecated Use TimeSlotCountOutputTypeDefaultArgs instead
     */
    export type TimeSlotCountOutputTypeArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = TimeSlotCountOutputTypeDefaultArgs<ExtArgs>
    /**
     * @deprecated Use ReservationCountOutputTypeDefaultArgs instead
     */
    export type ReservationCountOutputTypeArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = ReservationCountOutputTypeDefaultArgs<ExtArgs>
    /**
     * @deprecated Use TableDefaultArgs instead
     */
    export type TableArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = TableDefaultArgs<ExtArgs>
    /**
     * @deprecated Use TimeSlotDefaultArgs instead
     */
    export type TimeSlotArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = TimeSlotDefaultArgs<ExtArgs>
    /**
     * @deprecated Use ReservationDefaultArgs instead
     */
    export type ReservationArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = ReservationDefaultArgs<ExtArgs>
    /**
     * @deprecated Use ReservationTableDefaultArgs instead
     */
    export type ReservationTableArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = ReservationTableDefaultArgs<ExtArgs>
    /**
     * @deprecated Use WaitlistDefaultArgs instead
     */
    export type WaitlistArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = WaitlistDefaultArgs<ExtArgs>
    /**
     * @deprecated Use ReviewDefaultArgs instead
     */
    export type ReviewArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = ReviewDefaultArgs<ExtArgs>

  /**
   * Batch Payload for updateMany & deleteMany & createMany
   */

  export type BatchPayload = {
    count: number
  }

  /**
   * DMMF
   */
  export const dmmf: runtime.BaseDMMF
}