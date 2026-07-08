import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useSearchParams } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const shopParam = searchParams.get("shop") || "";
  const [shop, setShop] = useState(shopParam);
  const { errors } = actionData || loaderData;

  useEffect(() => {
    if (!shopParam) {
      return;
    }

    const loginUrl = window.location.href;

    try {
      if (window.top && window.top !== window.self) {
        window.top.location.href = loginUrl;
      }
    } catch {
      window.open(loginUrl, "_top");
    }
  }, [shopParam]);

  return (
    <AppProvider embedded={false}>
      <s-page>
        <Form method="post" target="_top" reloadDocument>
        <s-section heading="Log in">
          <s-text-field
            name="shop"
            label="Shop domain"
            details="example.myshopify.com"
            value={shop}
            onChange={(e) => setShop(e.currentTarget.value)}
            autocomplete="on"
            error={errors.shop}
          ></s-text-field>
          <s-button type="submit">Log in</s-button>
        </s-section>
        </Form>
      </s-page>
    </AppProvider>
  );
}
