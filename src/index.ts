#!/usr/bin/env node

process.on("SIGINT", () => process.exit(1));
process.on("SIGTERM", () => process.exit(1));

import { Command } from "commander";
import { configureProfileAsync } from "./configureProfileAsync";
import { login } from "./login";

const program = new Command();

program
  .option(
    "-p, --profile <name>",
    "The name of the profile to log in with (or configure)"
  )
  .option("-a, --all-profiles", "Run for all configured profiles")
  .option(
    "-f, --force-refresh",
    "Force a credential refresh, even if they are still valid"
  )
  .option("-c, --configure", "Configure the profile")
  .option(
    "-m, --mode <mode>",
    "'cli' to hide the login page and perform the login through the CLI (default behavior), 'gui' to perform the login through the Azure GUI (more reliable but only works on GUI operating system), 'debug' to show the login page but perform the login through the CLI (useful to debug issues with the CLI login)"
  )
  .option(
    "--no-prompt",
    "Do not prompt for input and accept the default choice",
    false
  )
  .option(
    "--no-verify-ssl",
    "Disable SSL Peer Verification for connections to AWS (no effect if behind proxy)"
  )
  .option(
    "--enable-chrome-seamless-sso",
    "Enable Chromium's pass-through authentication with Azure Active Directory Seamless Single Sign-On"
  )
  .option(
    "--disable-gpu",
    "Tell Playwright to pass the --disable-gpu flag to Chromium"
  )
  .parse(process.argv);

const options = program.opts();

const profileName =
  (options.profile as string | undefined) ||
  process.env.AWS_PROFILE ||
  "default";
const mode = (options.mode as string | undefined) || "cli";
const noPrompt = !options.prompt;
const awsNoVerifySsl = !options.verifySsl;
const enableChromeSeamlessSso = !!options.enableChromeSeamlessSso;
const forceRefresh = !!options.forceRefresh;
const disableGpu = !!options.disableGpu;

Promise.resolve()
  .then(() => {
    if (options.allProfiles) {
      return login.loginAll(
        mode,
        noPrompt,
        awsNoVerifySsl,
        enableChromeSeamlessSso,
        forceRefresh,
        disableGpu
      );
    }

    if (options.configure) return configureProfileAsync(profileName);
    return login.loginAsync(
      profileName,
      mode,
      noPrompt,
      awsNoVerifySsl,
      enableChromeSeamlessSso,
      disableGpu
    );
  })
  .catch((err: Error) => {
    if (err.name === "CLIError") {
      console.error(err.message);
      process.exit(2);
    } else {
      console.log(err);
    }
  });
