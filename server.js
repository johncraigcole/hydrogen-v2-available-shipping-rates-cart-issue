// Virtual entry point for the app
import * as remixBuild from '@remix-run/dev/server-build';
import {
  cartGetIdDefault,
  cartSetIdDefault,
  cartCreateDefault,
  createCartHandler,
  createStorefrontClient,
  storefrontRedirect,
  cartBuyerIdentityUpdateDefault,
  cartLinesAddDefault,
} from '@shopify/hydrogen';
import {
  createRequestHandler,
  getStorefrontHeaders,
  createCookieSessionStorage,
} from '@shopify/remix-oxygen';

/**
 * Export a fetch handler in module format.
 */
export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} executionContext
   */
  async fetch(request, env, executionContext) {
    try {
      /**
       * Open a cache instance in the worker and a custom session instance.
       */
      if (!env?.SESSION_SECRET) {
        throw new Error('SESSION_SECRET environment variable is not set');
      }

      const waitUntil = executionContext.waitUntil.bind(executionContext);
      const [cache, session] = await Promise.all([
        caches.open('hydrogen'),
        HydrogenSession.init(request, [env.SESSION_SECRET]),
      ]);

      /**
       * Create Hydrogen's Storefront client.
       */
      const {storefront} = createStorefrontClient({
        cache,
        waitUntil,
        i18n: getLocaleFromRequest(request),
        publicStorefrontToken: env.PUBLIC_STOREFRONT_API_TOKEN,
        privateStorefrontToken: env.PRIVATE_STOREFRONT_API_TOKEN,
        storeDomain: env.PUBLIC_STORE_DOMAIN,
        storefrontId: env.PUBLIC_STOREFRONT_ID,
        storefrontHeaders: getStorefrontHeaders(request),
      });
      const getQueryFragment = (requestHeaders) => {
        const cookie = requestHeaders.get('cookie');
        return /crashprotection\=off/.test(cookie)
          ? AVAILABLE_SHIP_RATES_BUG_FRAGMENT
          : CART_QUERY_FRAGMENT;
      };
      /*
       * Create a cart handler that will be used to
       * create and update the cart in the session.
       */
      const cart = createCartHandler({
        storefront,
        getCartId: cartGetIdDefault(request.headers),
        setCartId: cartSetIdDefault(),
        cartQueryFragment: getQueryFragment(request.headers),
        customMethods: {
          createCartWithCurrentBuyerIdentity: async ({lines}) => {
            // Using Hydrogen default cart query methods

            const customerAccessToken = session.get('customerAccessToken');
            if (!customerAccessToken) {
              throw new Error(
                'Please login before trying to use this cart creation method.',
              );
            }

            const getCartId = cartGetIdDefault(request.headers);

            if (!getCartId()) {
              // Create a new cart with the lines provided and the current access token
              return await cartCreateDefault({
                storefront,
              })({
                lines,
                buyerIdentity: {
                  customerAccessToken: customerAccessToken.accessToken,
                },
              });
            }
            console.log(lines);
            await cartLinesAddDefault({storefront, getCartId})(lines);
            return await cartBuyerIdentityUpdateDefault({
              storefront,
              getCartId,
            })({
              customerAccessToken: customerAccessToken.accessToken,
            });
          },
        },
      });

      /**
       * Create a Remix request handler and pass
       * Hydrogen's Storefront client to the loader context.
       */
      const handleRequest = createRequestHandler({
        build: remixBuild,
        mode: process.env.NODE_ENV,
        getLoadContext: () => ({session, storefront, cart, env, waitUntil}),
      });

      const response = await handleRequest(request);

      if (response.status === 404) {
        /**
         * Check for redirects only when there's a 404 from the app.
         * If the redirect doesn't exist, then `storefrontRedirect`
         * will pass through the 404 response.
         */
        return storefrontRedirect({request, response, storefront});
      }

      return response;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
      return new Response('An unexpected error occurred', {status: 500});
    }
  },
};

/**
 * @returns {I18nLocale}
 * @param {Request} request
 */
function getLocaleFromRequest(request) {
  const url = new URL(request.url);
  const firstPathPart = url.pathname.split('/')[1]?.toUpperCase() ?? '';

  let pathPrefix = '';
  let [language, country] = ['EN', 'US'];

  if (/^[A-Z]{2}-[A-Z]{2}$/i.test(firstPathPart)) {
    pathPrefix = '/' + firstPathPart;
    [language, country] = firstPathPart.split('-');
  }

  return {language, country, pathPrefix};
}

/**
 * This is a custom session implementation for your Hydrogen shop.
 * Feel free to customize it to your needs, add helper methods, or
 * swap out the cookie-based implementation with something else!
 */
export class HydrogenSession {
  #sessionStorage;
  #session;

  /**
   * @param {SessionStorage} sessionStorage
   * @param {Session} session
   */
  constructor(sessionStorage, session) {
    this.#sessionStorage = sessionStorage;
    this.#session = session;
  }

  /**
   * @static
   * @param {Request} request
   * @param {string[]} secrets
   */
  static async init(request, secrets) {
    const storage = createCookieSessionStorage({
      cookie: {
        name: 'session',
        httpOnly: true,
        path: '/',
        sameSite: 'lax',
        secrets,
      },
    });

    const session = await storage.getSession(request.headers.get('Cookie'));

    return new this(storage, session);
  }

  get has() {
    return this.#session.has;
  }

  get get() {
    return this.#session.get;
  }

  get flash() {
    return this.#session.flash;
  }

  get unset() {
    return this.#session.unset;
  }

  get set() {
    return this.#session.set;
  }

  destroy() {
    return this.#sessionStorage.destroySession(this.#session);
  }

  commit() {
    return this.#sessionStorage.commitSession(this.#session);
  }
}

const AVAILABLE_SHIP_RATES_BUG_FRAGMENT = `#graphql
fragment Money on MoneyV2 {
  currencyCode
  amount
}
fragment CartLine on CartLine {
  id
  quantity
  attributes {
    key
    value
  }
  cost {
    totalAmount {
      ...Money
    }
    amountPerQuantity {
      ...Money
    }
    compareAtAmountPerQuantity {
      ...Money
    }
  }
  merchandise {
    ... on ProductVariant {
      id
      availableForSale
      compareAtPrice {
        ...Money
      }
      price {
        ...Money
      }
      requiresShipping
      title
      image {
        id
        url
        altText
        width
        height

      }
      product {
        handle
        title
        id
      }
      selectedOptions {
        name
        value
      }
    }
  }
}
fragment CartApiQuery on Cart {
  id
  checkoutUrl
  totalQuantity
  buyerIdentity {
    countryCode
    customer {
      id
      email
      firstName
      lastName
      displayName
      lastIncompleteCheckout{
        availableShippingRates {
          shippingRates {
            handle
          }
        }
      }
    }
    email
    phone
  }
  lines(first: $numCartLines) {
    nodes {
      ...CartLine
    }
  }
  cost {
    subtotalAmount {
      ...Money
    }
    totalAmount {
      ...Money
    }
    totalDutyAmount {
      ...Money
    }
    totalTaxAmount {
      ...Money
    }
  }
  note
  attributes {
    key
    value
  }
  discountCodes {
    code
    applicable
  }
}
`;
// NOTE: https://shopify.dev/docs/api/storefront/latest/queries/cart
const CART_QUERY_FRAGMENT = `#graphql
  fragment Money on MoneyV2 {
    currencyCode
    amount
  }
  fragment CartLine on CartLine {
    id
    quantity
    attributes {
      key
      value
    }
    cost {
      totalAmount {
        ...Money
      }
      amountPerQuantity {
        ...Money
      }
      compareAtAmountPerQuantity {
        ...Money
      }
    }
    merchandise {
      ... on ProductVariant {
        id
        availableForSale
        compareAtPrice {
          ...Money
        }
        price {
          ...Money
        }
        requiresShipping
        title
        image {
          id
          url
          altText
          width
          height

        }
        product {
          handle
          title
          id
        }
        selectedOptions {
          name
          value
        }
      }
    }
  }
  fragment CartApiQuery on Cart {
    id
    checkoutUrl
    totalQuantity
    buyerIdentity {
      countryCode
      customer {
        id
        email
        firstName
        lastName
        displayName

      }
      email
      phone
    }
    lines(first: $numCartLines) {
      nodes {
        ...CartLine
      }
    }
    cost {
      subtotalAmount {
        ...Money
      }
      totalAmount {
        ...Money
      }
      totalDutyAmount {
        ...Money
      }
      totalTaxAmount {
        ...Money
      }
    }
    note
    attributes {
      key
      value
    }
    discountCodes {
      code
      applicable
    }
  }
`;

/** @typedef {import('@shopify/remix-oxygen').SessionStorage} SessionStorage */
/** @typedef {import('@shopify/remix-oxygen').Session} Session */
