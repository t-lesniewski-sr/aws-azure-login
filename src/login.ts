import {
  chromium,
  BrowserContext,
  Page,
  Route,
  Request as PlaywrightRequest,
  ElementHandle,
} from "playwright-core";
import { mkdir } from "fs/promises";
import inquirer, { QuestionCollection, Question } from "inquirer";
import zlib from "zlib";
import { STS, STSClientConfig } from "@aws-sdk/client-sts";
import { load } from "cheerio";
import { v4 } from "uuid";
import _debug from "debug";
import { CLIError } from "./CLIError";
import { awsConfig, ProfileConfig } from "./awsConfig";
import proxy from "proxy-agent";
import { paths } from "./paths";
import { Agent } from "https";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const debug = _debug("aws-azure-login");

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const WIDTH = 425;
const HEIGHT = 550;
const DELAY_ON_UNRECOGNIZED_PAGE = 1000;
const MAX_UNRECOGNIZED_PAGE_DELAY = 30 * 1000;

// source: https://docs.microsoft.com/en-us/azure/active-directory/hybrid/how-to-connect-sso-quick-start#google-chrome-all-platforms
const AZURE_AD_SSO = "autologon.microsoftazuread-sso.com";
const AWS_SAML_ENDPOINT = "https://signin.aws.amazon.com/saml";
const AWS_CN_SAML_ENDPOINT = "https://signin.amazonaws.cn/saml";
const AWS_GOV_SAML_ENDPOINT = "https://signin.amazonaws-us-gov.com/saml";

interface Role {
  roleArn: string;
  principalArn: string;
}

/**
 * To proxy the input/output of the Azure login page, it's easiest to run a loop that
 * monitors the state of the page and then perform the corresponding CLI behavior.
 * The states have a name that is used for the debug messages, a selector that is used
 * with playwright's page.$(selector) to determine if the state is active, and a handler
 * that is called if the state is active.
 */
const states = [
  {
    name: "username input",
    selector: `input[name="loginfmt"]:not(.moveOffScreen)`,
    async handler(
      page: Page,
      _selected: ElementHandle,
      noPrompt: boolean,
      defaultUsername: string
    ): Promise<void> {
      const error = await page.$(".alert-error");
      if (error) {
        debug("Found error message. Displaying");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const errorMessage = await page.evaluate(
          // eslint-disable-next-line
          (err) => err.textContent,
          error
        );
        console.log(errorMessage);
      }

      let username;

      if (noPrompt && defaultUsername) {
        debug("Not prompting user for username");
        username = defaultUsername;
      } else {
        debug("Prompting user for username");
        ({ username } = await inquirer.prompt([
          {
            name: "username",
            message: "Username:",
            default: defaultUsername,
          } as Question,
        ]));
      }

      debug("Waiting for username input to be visible");
      await page.waitForSelector(`input[name="loginfmt"]`, {
        state: "visible",
        timeout: 60000,
      });

      debug("Focusing on username input");
      await page.focus(`input[name="loginfmt"]`);

      debug("Clearing input");
      for (let i = 0; i < 100; i++) {
        await page.keyboard.press("Backspace");
      }

      debug("Typing username");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await page.keyboard.type(username);

      await delay(500);

      debug("Waiting for submit button to be visible");
      await page.waitForSelector(`input[type=submit]`, {
        state: "visible",
        timeout: 60000,
      });

      debug("Submitting form");
      await page.click("input[type=submit]");

      await delay(500);

      debug("Waiting for submission to finish");
      await Promise.race([
        page.waitForSelector(
          `input[name=loginfmt].has-error,input[name=loginfmt].moveOffScreen`,
          { timeout: 60000 }
        ),
        (async (): Promise<void> => {
          await delay(1000);
          await page.waitForSelector(`input[name=loginfmt]`, {
            state: "hidden",
            timeout: 60000,
          });
        })(),
      ]);
    },
  },
  {
    name: "account selection",
    selector: `#aadTile > div > div.table-cell.tile-img > img`,
    async handler(page: Page): Promise<void> {
      debug("Multiple accounts associated with username.");
      const aadTile = await page.$("#aadTileTitle");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const aadTileMessage: string = await page.evaluate(
        // eslint-disable-next-line
        (a) => a!.textContent ?? "",
        aadTile
      );

      const msaTile = await page.$("#msaTileTitle");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const msaTileMessage: string = await page.evaluate(
        // eslint-disable-next-line
        (m) => m!.textContent ?? "",
        msaTile
      );

      const accounts = [
        { message: aadTileMessage, selector: "#aadTileTitle" },
        { message: msaTileMessage, selector: "#msaTileTitle" },
      ];

      let account;
      if (accounts.length === 0) {
        throw new CLIError("No accounts found on account selection screen.");
      } else if (accounts.length === 1) {
        account = accounts[0];
      } else {
        debug("Asking user to choose account");
        console.log(
          "It looks like this Username is used with more than one account from Microsoft. Which one do you want to use?"
        );
        const answers = await inquirer.prompt([
          {
            name: "account",
            message: "Account:",
            type: "list",
            choices: accounts.map((a) => a.message),
            default: aadTileMessage,
          } as Question,
        ]);

        account = accounts.find((a) => a.message === answers.account);
      }

      if (!account) {
        throw new Error("Unable to find account");
      }

      debug(`Proceeding with account ${account.selector}`);
      await page.click(account.selector);
      await delay(500);
    },
  },
  {
    name: "passwordless",
    selector: `input[value='Send notification']`,
    async handler(page: Page) {
      debug("Sending notification");
      // eslint-disable-next-line
      await page.click("input[value='Send notification']");
      debug("Waiting for auth code");
      // eslint-disable-next-line
      await page.waitForSelector(`#idRemoteNGC_DisplaySign`, {
        state: "visible",
        timeout: 60000,
      });
      debug("Printing the message displayed");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const messageElement = await page.$(
        "#idDiv_RemoteNGC_PollingDescription"
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const codeElement = await page.$("#idRemoteNGC_DisplaySign");
      // eslint-disable-next-line
      const message = await page.evaluate(
        // eslint-disable-next-line
        (el) => el!.textContent,
        messageElement
      );
      console.log(message);
      debug("Printing the auth code");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const authCode = await page.evaluate(
        // eslint-disable-next-line
        (el) => el!.textContent,
        codeElement
      );
      console.log(authCode);
      debug("Waiting for response");
      await page.waitForSelector(`#idRemoteNGC_DisplaySign`, {
        state: "hidden",
        timeout: 60000,
      });
    },
  },
  {
    name: "password input",
    selector: `input[name="Password"]:not(.moveOffScreen),input[name="passwd"]:not(.moveOffScreen)`,
    async handler(
      page: Page,
      _selected: ElementHandle,
      noPrompt: boolean,
      _defaultUsername: string,
      defaultPassword: string
    ): Promise<void> {
      const error = await page.$(".alert-error");
      if (error) {
        debug("Found error message. Displaying");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const errorMessage = await page.evaluate(
          // eslint-disable-next-line
          (err) => err.textContent,
          error
        );
        console.log(errorMessage);
        defaultPassword = ""; // Password error. Unset the default and allow user to enter it.
      }

      let password;

      if (noPrompt && defaultPassword) {
        debug("Not prompting user for password");
        password = defaultPassword;
      } else {
        debug("Prompting user for password");
        ({ password } = await inquirer.prompt([
          {
            name: "password",
            message: "Password:",
            type: "password",
          } as Question,
        ]));
      }

      debug("Focusing on password input");
      await page.focus(`input[name="Password"],input[name="passwd"]`);

      debug("Typing password");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await page.keyboard.type(password);

      debug("Submitting form");
      await page.click("span[class=submit],input[type=submit]");

      debug("Waiting for a delay");
      await delay(500);
    },
  },
  {
    name: "TFA instructions",
    selector: `#idDiv_SAOTCAS_Description`,
    async handler(page: Page, selected: ElementHandle): Promise<void> {
      const descriptionMessage = (await page.evaluate(
        // eslint-disable-next-line
        (description) => description.textContent,
        selected
      )) as string;
      console.log(descriptionMessage);

      try {
        debug("Checking if authentication code is displayed");
        const authenticationCodeElement = await page.$(
          "#idRichContext_DisplaySign"
        );
        debug("Reading the authentication code");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const authenticationCode = await page.evaluate(
          // eslint-disable-next-line
          (d) => d!.textContent,
          authenticationCodeElement
        );
        debug("Printing the authentication code to console");
        console.log(authenticationCode);
      } catch {
        debug("No authentication code found on page");
      }

      debug("Waiting for response");
      await page.waitForSelector(`#idDiv_SAOTCAS_Description`, {
        state: "hidden",
        timeout: 60000,
      });
    },
  },
  {
    name: "TFA failed",
    selector: `#idDiv_SAASDS_Description,#idDiv_SAASTO_Description`,
    async handler(page: Page, selected: ElementHandle): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const descriptionMessage = await page.evaluate(
        // eslint-disable-next-line
        (description) => description!.textContent ?? "",
        selected
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      throw new CLIError(descriptionMessage);
    },
  },
  {
    name: "TFA code input",
    selector: "input[name=otc]:not(.moveOffScreen)",
    async handler(page: Page): Promise<void> {
      const error = await page.$(".alert-error");
      if (error) {
        debug("Found error message. Displaying");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const errorMessage = await page.evaluate(
          // eslint-disable-next-line
          (err) => err.textContent,
          error
        );
        console.log(errorMessage);
      } else {
        const description = await page.$("#idDiv_SAOTCC_Description");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const descriptionMessage = await page.evaluate(
          // eslint-disable-next-line
          (d) => d!.textContent,
          description
        );
        console.log(descriptionMessage);
      }

      const { verificationCode } = await inquirer.prompt([
        {
          name: "verificationCode",
          message: "Verification Code:",
        } as Question,
      ]);

      debug("Focusing on verification code input");
      await page.focus(`input[name="otc"]`);

      debug("Clearing input");
      for (let i = 0; i < 100; i++) {
        await page.keyboard.press("Backspace");
      }

      debug("Typing verification code");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await page.keyboard.type(verificationCode);

      debug("Submitting form");
      await page.click("input[type=submit]");

      debug("Waiting for submission to finish");
      await Promise.race([
        page.waitForSelector(
          `input[name=otc].has-error,input[name=otc].moveOffScreen`,
          { timeout: 60000 }
        ),
        (async (): Promise<void> => {
          await delay(1000);
          await page.waitForSelector(`input[name=otc]`, {
            state: "hidden",
            timeout: 60000,
          });
        })(),
      ]);
    },
  },
  {
    name: "Remember me",
    selector: `#KmsiDescription`,
    async handler(
      page: Page,
      _selected: ElementHandle,
      _noPrompt: boolean,
      _defaultUsername: string,
      _defaultPassword: string | undefined,
      rememberMe: boolean
    ): Promise<void> {
      if (rememberMe) {
        debug("Clicking remember me button");
        await page.click("#idSIButton9");
      } else {
        debug("Clicking don't remember button");
        await page.click("#idBtn_Back");
      }

      debug("Waiting for a delay");
      await delay(500);
    },
  },
  {
    name: "Service exception",
    selector: "#service_exception_message",
    async handler(page: Page, selected: ElementHandle): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const descriptionMessage = await page.evaluate(
        // eslint-disable-next-line
        (description) => description!.textContent ?? "",
        selected
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      throw new CLIError(descriptionMessage);
    },
  },
];

export const login = {
  async loginAsync(
    profileName: string,
    mode: string,
    noPrompt: boolean,
    awsNoVerifySsl: boolean,
    enableChromeSeamlessSso: boolean,
    disableGpu: boolean
  ): Promise<void> {
    let headless, cliProxy;
    if (mode === "cli") {
      headless = true;
      cliProxy = true;
    } else if (mode === "gui") {
      headless = false;
      cliProxy = false;
    } else if (mode === "debug") {
      headless = false;
      cliProxy = true;
    } else {
      throw new CLIError("Invalid mode");
    }

    const profile = await this._loadProfileAsync(profileName);
    let assertionConsumerServiceURL = AWS_SAML_ENDPOINT;
    if (profile.region && profile.region.startsWith("us-gov")) {
      assertionConsumerServiceURL = AWS_GOV_SAML_ENDPOINT;
    }
    if (profile.region && profile.region.startsWith("cn-")) {
      assertionConsumerServiceURL = AWS_CN_SAML_ENDPOINT;
    }

    console.log("Using AWS SAML endpoint", assertionConsumerServiceURL);

    const loginUrl = await this._createLoginUrlAsync(
      profile.azure_app_id_uri,
      profile.azure_tenant_id,
      assertionConsumerServiceURL
    );
    const samlResponse = await this._performLoginAsync(
      loginUrl,
      headless,
      cliProxy,
      noPrompt,
      profile.azure_default_username,
      profile.azure_default_password,
      enableChromeSeamlessSso,
      profile.azure_default_remember_me,
      disableGpu
    );
    const roles = this._parseRolesFromSamlResponse(samlResponse);
    const { role, durationHours } = await this._askUserForRoleAndDurationAsync(
      roles,
      noPrompt,
      profile.azure_default_role_arn,
      profile.azure_default_duration_hours
    );

    await this._assumeRoleAsync(
      profileName,
      samlResponse,
      role,
      durationHours,
      awsNoVerifySsl,
      profile.region
    );
  },

  async loginAll(
    mode: string,
    noPrompt: boolean,
    awsNoVerifySsl: boolean,
    enableChromeSeamlessSso: boolean,
    forceRefresh: boolean,
    disableGpu: boolean
  ): Promise<void> {
    const profiles = await awsConfig.getAllProfileNames();

    if (!profiles) {
      return;
    }

    for (const profile of profiles) {
      debug(`Check if profile ${profile} is expired or is about to expire`);
      if (
        !forceRefresh &&
        !(await awsConfig.isProfileAboutToExpireAsync(profile))
      ) {
        debug(`Profile ${profile} not yet due for refresh.`);
        continue;
      }

      debug(`Run login for profile: ${profile}`);
      await this.loginAsync(
        profile,
        mode,
        noPrompt,
        awsNoVerifySsl,
        enableChromeSeamlessSso,
        disableGpu
      );
    }
  },

  // Gather data from environment variables
  _loadProfileFromEnv(): { [key: string]: string } {
    const env: { [key: string]: string } = {};
    const options = [
      "azure_tenant_id",
      "azure_app_id_uri",
      "azure_default_username",
      "azure_default_password",
      "azure_default_role_arn",
      "azure_default_duration_hours",
    ];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const envVar = process.env[opt];
      const envVarUpperCase = process.env[opt.toUpperCase()];

      if (envVar) {
        env[opt] = envVar;
      } else if (envVarUpperCase) {
        env[opt] = envVarUpperCase;
      }
    }
    debug("Environment");
    debug({
      ...env,
      azure_default_password: "xxxxxxxxxx",
    });
    return env;
  },

  // Load the profile
  async _loadProfileAsync(profileName: string): Promise<ProfileConfig> {
    const profile = await awsConfig.getProfileConfigAsync(profileName);

    if (!profile)
      throw new CLIError(
        `Unknown profile '${profileName}'. You must configure it first with --configure.`
      );

    const env = this._loadProfileFromEnv();
    for (const prop in env) {
      if (env[prop]) {
        profile[prop] = env[prop] === null ? profile[prop] : env[prop];
      }
    }

    if (!profile.azure_tenant_id || !profile.azure_app_id_uri)
      throw new CLIError(
        `Profile '${profileName}' is not configured properly.`
      );

    console.log(`Logging in with profile '${profileName}'...`);
    return profile;
  },

  /**
   * Create the Azure login SAML URL.
   * @param {string} appIdUri - The app ID URI
   * @param {string} tenantId - The Azure tenant ID
   * @param {string} assertionConsumerServiceURL - The AWS SAML endpoint that Azure should send the SAML response to
   * @returns {string} The login URL
   * @private
   */
  _createLoginUrlAsync(
    appIdUri: string,
    tenantId: string,
    assertionConsumerServiceURL: string
  ): Promise<string> {
    debug("Generating UUID for SAML request");
    const id = v4();

    const samlRequest = `
        <samlp:AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:metadata" ID="id${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" IsPassive="false" AssertionConsumerServiceURL="${assertionConsumerServiceURL}" xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">
            <Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${appIdUri}</Issuer>
            <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"></samlp:NameIDPolicy>
        </samlp:AuthnRequest>
        `;
    debug("Generated SAML request", samlRequest);

    debug("Deflating SAML");

    return new Promise((resolve, reject) => {
      zlib.deflateRaw(samlRequest, (err, samlBuffer) => {
        if (err) {
          return reject(err);
        }

        debug("Encoding SAML in base64");
        const samlBase64 = samlBuffer.toString("base64");

        const url = `https://login.microsoftonline.com/${tenantId}/saml2?SAMLRequest=${encodeURIComponent(
          samlBase64
        )}`;
        debug("Created login URL", url);

        return resolve(url);
      });
    });
  },

  /**
   * Perform the login using Chromium (Playwright).
   * @param {string} url - The login URL
   * @param {boolean} headless - True to hide the GUI, false to show it.
   * @param {boolean} cliProxy - True to proxy input/output through the CLI, false to leave it in the GUI
   * @param {bool} [noPrompt] - Enable skipping of user prompting
   * @param {string} [defaultUsername] - The default username
   * @param {string} [defaultPassword] - The default password
   * @param {bool} [enableChromeSeamlessSso] - chrome seamless SSO
   * @param {bool} [rememberMe] - Enable remembering the session
   * @param {bool} [disableGpu] - Disables GPU Acceleration
   * @returns {Promise.<string>} The SAML response.
   * @private
   */
  async _performLoginAsync(
    url: string,
    headless: boolean,
    cliProxy: boolean,
    noPrompt: boolean,
    defaultUsername: string,
    defaultPassword: string | undefined,
    enableChromeSeamlessSso: boolean,
    rememberMe: boolean,
    disableGpu: boolean
  ): Promise<string> {
    debug("Loading login page in Chromium (Playwright)");

    let context: BrowserContext | undefined;

    try {
      const launchArgs: string[] = [];
      if (enableChromeSeamlessSso)
        launchArgs.push(
          `--auth-server-whitelist=${AZURE_AD_SSO}`,
          `--auth-negotiate-delegate-whitelist=${AZURE_AD_SSO}`
        );
      if (process.env.https_proxy)
        launchArgs.push(`--proxy-server=${process.env.https_proxy}`);
      if (disableGpu) launchArgs.push("--disable-gpu");

      const viewportSize = { width: WIDTH - 15, height: HEIGHT - 35 };

      // Playwright passes --use-mock-keychain by default which blocks WebAuthn/YubiKey.
      // Ignoring it restores native OS keychain access needed for physical security keys.
      // Also ignore --disable-extensions so extensions in the profile (e.g. Bitwarden) load.
      // To install Bitwarden into the profile run:
      //   cp -r "$HOME/Library/Application Support/Dia/User Data/Default/Extensions/nngceckbapebfimnlniiiahkandclblb" \
      //         "$HOME/.aws/chromium/Default/Extensions/nngceckbapebfimnlniiiahkandclblb"
      const ignoreDefaultArgs = ["--use-mock-keychain", "--disable-extensions"];

      const executablePath =
        process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        undefined;

      await mkdir(paths.chromium, { recursive: true });

      try {
        context = await chromium.launchPersistentContext(paths.chromium, {
          headless,
          args: launchArgs,
          ignoreDefaultArgs,
          executablePath,
          viewport: viewportSize,
          extraHTTPHeaders: { "Accept-Language": "en" },
        });

        const pages = context.pages();
        const page = pages.length > 0 ? pages[0] : await context.newPage();

        // Intercept SAML response
        let samlResponseData: string | undefined;
        const samlResponsePromise = new Promise<void>((resolve) => {
          const endpoints = [
            AWS_SAML_ENDPOINT,
            AWS_GOV_SAML_ENDPOINT,
            AWS_CN_SAML_ENDPOINT,
          ];
          for (const endpoint of endpoints) {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            page.route(
              endpoint,
              async (route: Route, request: PlaywrightRequest) => {
                samlResponseData = request.postData() ?? undefined;
                await route.fulfill({
                  status: 200,
                  contentType: "text/plain",
                  body: "",
                });
                resolve();
                debug("Received SAML response, closing browser");
                setTimeout(() => {
                  if (context) {
                    context.close().catch(() => undefined);
                    context = undefined;
                  }
                }, 100);
              }
            );
          }
        });

        try {
          debug("Going to login page");
          await page.goto(url, { waitUntil: "domcontentloaded" });
        } catch (err) {
          if (err instanceof Error) {
            debug(`Error during loading the first page: ${err.message}`);
          }
        }

        if (cliProxy) {
          let totalUnrecognizedDelay = 0;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (samlResponseData !== undefined) break;

            let foundState = false;
            for (let i = 0; i < states.length; i++) {
              const state = states[i];

              let selected;
              try {
                selected = await page.$(state.selector);
              } catch (err) {
                if (err instanceof Error) {
                  debug(
                    `Error when running state "${
                      state.name
                    }". ${err.toString()}. Retrying...`
                  );
                }
                break;
              }

              if (selected) {
                foundState = true;
                debug(`Found state: ${state.name}`);

                await Promise.race([
                  samlResponsePromise,
                  state.handler(
                    page,
                    selected,
                    noPrompt,
                    defaultUsername,
                    defaultPassword,
                    rememberMe
                  ),
                ]);

                debug(`Finished state: ${state.name}`);
                break;
              }
            }

            if (foundState) {
              totalUnrecognizedDelay = 0;
            } else {
              debug("State not recognized!");
              if (totalUnrecognizedDelay > MAX_UNRECOGNIZED_PAGE_DELAY) {
                const path = "aws-azure-login-unrecognized-state.png";
                await page.screenshot({ path });
                throw new CLIError(
                  `Unable to recognize page state! A screenshot has been dumped to ${path}. If this problem persists, try running with --mode=gui or --mode=debug`
                );
              }
              totalUnrecognizedDelay += DELAY_ON_UNRECOGNIZED_PAGE;
              await delay(DELAY_ON_UNRECOGNIZED_PAGE);
            }
          }
        } else {
          console.log("Please complete the login in the opened window");
          await samlResponsePromise;
        }

        if (!samlResponseData) {
          throw new Error("SAML response not found");
        }

        const samlResponse = new URLSearchParams(samlResponseData).get(
          "SAMLResponse"
        );
        debug("Found SAML response", samlResponse);

        if (!samlResponse) {
          throw new Error("SAML response not found");
        }

        return samlResponse;
      } finally {
        if (context) {
          await context.close().catch(() => undefined);
          context = undefined;
        }
      }
    } finally {
      if (context) {
        await context.close().catch(() => undefined);
      }
    }
  },

  /**
   * Parse AWS roles out of the SAML response
   * @param {string} assertion - The SAML assertion
   * @returns {Array.<{roleArn: string, principalArn: string}>} The roles
   * @private
   */
  _parseRolesFromSamlResponse(assertion: string): Role[] {
    debug("Converting assertion from base64 to ASCII");
    const samlText = Buffer.from(assertion, "base64").toString("ascii");
    debug("Converted", samlText);

    debug("Parsing SAML XML");
    const saml = load(samlText, { xmlMode: true });

    debug("Looking for role SAML attribute");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const roles: Role[] = saml(
      "Attribute[Name='https://aws.amazon.com/SAML/Attributes/Role']>AttributeValue"
    )
      .map(function () {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const roleAndPrincipal = saml(this).text();
        const parts = roleAndPrincipal.split(",");

        // Role / Principal claims may be in either order
        const [roleIdx, principalIdx] = parts[0].includes(":role/")
          ? [0, 1]
          : [1, 0];
        const roleArn = parts[roleIdx].trim();
        const principalArn = parts[principalIdx].trim();
        return { roleArn, principalArn };
      })
      .get();
    debug("Found roles", roles);
    return roles;
  },

  /**
   * Ask the user for the role they want to use.
   * @param {Array.<{roleArn: string, principalArn: string}>} roles - The roles to pick from
   * @param {bool} [noPrompt] - Enable skipping of user prompting
   * @param {string} [defaultRoleArn] - The default role ARN
   * @param {number} [defaultDurationHours] - The default session duration in hours
   * @returns {Promise.<{role: string, durationHours: number}>} The selected role and duration
   * @private
   */
  async _askUserForRoleAndDurationAsync(
    roles: Role[],
    noPrompt: boolean,
    defaultRoleArn: string,
    defaultDurationHours: string
  ): Promise<{
    role: Role;
    durationHours: number;
  }> {
    let role;
    let durationHours = parseInt(defaultDurationHours, 10);
    const questions: QuestionCollection[] = [];
    if (roles.length === 0) {
      throw new CLIError("No roles found in SAML response.");
    } else if (roles.length === 1) {
      debug("Choosing the only role in response");
      role = roles[0];
    } else {
      if (noPrompt && defaultRoleArn) {
        role = roles.find((r) => r.roleArn === defaultRoleArn);
      }

      if (role) {
        debug("Valid role found. No need to ask.");
      } else {
        debug("Asking user to choose role");
        questions.push({
          name: "role",
          message: "Role:",
          type: "list",
          choices: [...roles.map((r) => r.roleArn)].sort(),
          default: defaultRoleArn,
        });
      }
    }

    if (noPrompt && defaultDurationHours) {
      debug("Default durationHours found. No need to ask.");
    } else {
      questions.push({
        name: "durationHours",
        message: "Session Duration Hours (up to 12):",
        type: "input",
        default: defaultDurationHours || 1,
        validate: (input): boolean | string => {
          input = Number(input);
          if (input > 0 && input <= 12) return true;
          return "Duration hours must be between 0 and 12";
        },
      });
    }

    // Don't prompt for questions if not needed, an unneeded TTYWRAP prevents node from exiting when
    // user is logged in and using multiple profiles --all-profiles and --no-prompt
    if (questions.length > 0) {
      const answers = await inquirer.prompt(questions);
      if (!role) role = roles.find((r) => r.roleArn === answers.role);
      if (answers.durationHours) {
        durationHours = parseInt(answers.durationHours as string, 10);
      }
    }

    if (!role) {
      throw new Error(`Unable to find role`);
    }

    return { role, durationHours };
  },

  /**
   * Assume the role.
   * @param {string} profileName - The profile name
   * @param {string} assertion - The SAML assertion
   * @param {string} role - The role to assume
   * @param {number} durationHours - The session duration in hours
   * @param {bool} awsNoVerifySsl - Whether to have the AWS CLI verify SSL
   * @param {string} region - AWS region, if specified
   * @returns {Promise} A promise
   * @private
   */
  async _assumeRoleAsync(
    profileName: string,
    assertion: string,
    role: Role,
    durationHours: number,
    awsNoVerifySsl: boolean,
    region: string
  ): Promise<void> {
    console.log(`Assuming role ${role.roleArn} in region ${region}...`);
    let stsOptions: STSClientConfig = {};
    if (process.env.https_proxy) {
      stsOptions = {
        ...stsOptions,
        requestHandler: new NodeHttpHandler({
          httpsAgent: proxy(process.env.https_proxy),
        }),
      };
    }

    if (awsNoVerifySsl) {
      stsOptions = {
        ...stsOptions,
        requestHandler: new NodeHttpHandler({
          httpsAgent: new Agent({
            rejectUnauthorized: false,
          }),
        }),
      };
    }

    if (region) {
      stsOptions = {
        ...stsOptions,
        region,
      };
    }

    const sts = new STS(stsOptions);
    const res = await sts.assumeRoleWithSAML({
      PrincipalArn: role.principalArn,
      RoleArn: role.roleArn,
      SAMLAssertion: assertion,
      DurationSeconds: Math.round(durationHours * 60 * 60),
    });

    if (!res.Credentials) {
      debug("Unable to get security credentials from AWS");
      return;
    }

    await awsConfig.setProfileCredentialsAsync(profileName, {
      aws_access_key_id: res.Credentials.AccessKeyId ?? "",
      aws_secret_access_key: res.Credentials.SecretAccessKey ?? "",
      aws_session_token: res.Credentials.SessionToken ?? "",
      aws_expiration: res.Credentials.Expiration?.toISOString() ?? "",
    });
  },
};
