[![view on npm](http://img.shields.io/npm/v/aws-azure-login.svg)](https://www.npmjs.org/package/aws-azure-login)
[![npm module downloads per month](http://img.shields.io/npm/dm/aws-azure-login.svg)](https://www.npmjs.org/package/aws-azure-login)

# aws-azure-login

If your organization uses [Azure Active Directory](https://azure.microsoft.com) to provide SSO login to the AWS console, then there is no easy way to log in on the command line or to use the [AWS CLI](https://aws.amazon.com/cli/). This tool fixes that. It lets you use the normal Azure AD login (including MFA and hardware security keys) from a command line to create a federated AWS session and places the temporary credentials in the proper place for the AWS CLI and SDKs.

## Requirements

- [Node.js](https://nodejs.org/) v20 or higher
- Google Chrome or Chromium installed on your system

## Installation

### macOS / Linux

    npm install -g aws-azure-login

### Windows

    npm install -g aws-azure-login

### Docker

A Docker image has been built with aws-azure-login preinstalled. You simply need to run the command with a volume mounted to your AWS configuration directory.

    docker run --rm -it -v ~/.aws:/root/.aws aws-azure-login/aws-azure-login

The Docker image is configured with an entrypoint so you can just feed any arguments in at the end.

You can also put the docker-launch.sh script into your bin directory for the aws-azure-login command to function as usual:

    sudo curl -o /usr/local/bin/aws-azure-login https://raw.githubusercontent.com/aws-azure-login/aws-azure-login/main/docker-launch.sh -L
    sudo chmod o+x /usr/local/bin/aws-azure-login

Now just run `aws-azure-login`.

## Usage

### Configuration

#### AWS

To configure the aws-azure-login client run:

    aws-azure-login --configure

You'll need your [Azure Tenant ID and the App ID URI](#getting-your-tenant-id-and-app-id-uri). To configure a named profile, use the --profile flag.

    aws-azure-login --configure --profile foo

##### GovCloud Support

To use aws-azure-login with AWS GovCloud, set the `region` profile property in your ~/.aws/config to the one of the GovCloud regions:

- us-gov-west-1
- us-gov-east-1

##### China Region Support

To use aws-azure-login with AWS China Cloud, set the `region` profile property in your ~/.aws/config to the China region:

- cn-north-1

#### Staying logged in, skip username/password for future logins

During the configuration you can decide to stay logged in:

    ? Stay logged in: skip authentication while refreshing aws credentials (true|false) (false)

If you set this configuration to true, the usual authentication with username/password/MFA is skipped as it's using session cookies to remember your identity. This enables you to use `--no-prompt` without the need to store your password anywhere, it's an alternative for using environment variables as described below.
As soon as you went through the full login procedure once, you can just use:

    aws-azure-login --no-prompt

or

    aws-azure-login --profile foo --no-prompt

to refresh your aws credentials.

#### Browser extensions (Bitwarden, etc.)

When using `--mode gui` with "stay logged in" enabled, the browser opens a persistent profile stored at `~/.aws/chromium`. You can install extensions (e.g. Bitwarden password manager) into this profile:

1. Run `aws-azure-login --mode gui` once to create the profile directory.
2. Open `chrome://extensions` in the browser window that appears.
3. Enable **Developer mode** and click **Load unpacked**.
4. Point it at your extension's directory.

The extension will persist across future runs.

#### Environment Variables

You can optionally store your responses as environment variables:

- `AZURE_TENANT_ID`
- `AZURE_APP_ID_URI`
- `AZURE_DEFAULT_USERNAME`
- `AZURE_DEFAULT_PASSWORD`
- `AZURE_DEFAULT_ROLE_ARN`
- `AZURE_DEFAULT_DURATION_HOURS`

To avoid having to `<Enter>` through the prompts after setting these environment variables, use the `--no-prompt` option when running the command.

    aws-azure-login --no-prompt

Use the `HISTCONTROL` environment variable to avoid storing the password in your bash history (notice the space at the beginning):

    $ HISTCONTROL=ignoreboth
    $  export AZURE_DEFAULT_PASSWORD=mypassword
    $ aws-azure-login

### Logging In

Once aws-azure-login is configured, you can log in. For the default profile, just run:

    aws-azure-login

You will be prompted for your username and password. If MFA is required you'll also be prompted for a verification code or mobile device approval. To log in with a named profile:

    aws-azure-login --profile foo

Alternatively, you can set the `AWS_PROFILE` environmental variable to the name of the profile just like the AWS CLI.

Once you log in you can use the AWS CLI or SDKs as usual!

#### GUI mode (recommended for MFA and hardware security keys)

If you use MFA via a hardware security key (YubiKey, FIDO2) or want to use the actual Azure web form:

    aws-azure-login --mode gui

GUI mode opens a real browser window. Hardware security keys (WebAuthn/FIDO2) only work in GUI mode.

_Note:_ on some systems you may need to disable GPU hardware acceleration if the browser window renders incorrectly:

    aws-azure-login --mode gui --disable-gpu

### Behind corporate proxy

If behind corporate proxy, then just set https_proxy env variable.

## Automation

### Renew credentials for all configured profiles

You can renew credentials for all configured profiles in one run. This is especially useful, if the maximum session length on AWS side is configured to a low value due to security constraints. Just run:

    aws-azure-login --all-profiles

If you configure all profiles to stay logged in, you can easily skip the prompts:

    aws-azure-login --all-profiles --no-prompt

This will allow you to automate the credentials refresh procedure, eg. by running a cronjob every 5 minutes.
To skip unnecessary calls, the credentials are only getting refreshed if the time to expire is lower than 11 minutes.

## Getting Your Tenant ID and App ID URI

Your Azure AD system admin should be able to provide you with your Tenant ID and App ID URI. If you can't get it from them, you can scrape it from a login page from the myapps.microsoft.com page.

1. Load the myapps.microsoft.com page.
2. Click the chicklet for the login you want.
3. In the window the pops open quickly copy the login.microsoftonline.com URL. (If you miss it just try again. You can also open the developer console with nagivation preservation to capture the URL.)
4. The GUID right after login.microsoftonline.com/ is the tenant ID.
5. Copy the SAMLRequest URL param.
6. Paste it into a URL decoder ([like this one](https://www.samltool.com/url.php)) and decode.
7. Paste the decoded output into the a SAML deflated and encoded XML decoder ([like this one](https://www.samltool.com/decode.php)).
8. In the decoded XML output the value of the `Audience` tag is the App ID URI.
9. You may double-check tenant ID using `Attribute` tag named `tenantid` provided in XML.

## How It Works

The Azure login page uses JavaScript, which requires a real web browser. To automate this from a command line, aws-azure-login uses [Playwright](https://playwright.dev/), which automates a real browser. It loads the Azure login page behind the scenes, populates your username and password (and MFA token), parses the SAML assertion, uses the [AWS STS AssumeRoleWithSAML API](http://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithSAML.html) to get temporary credentials, and saves these in the CLI credentials file.

## Troubleshooting

If something isn't working, you can fall back to GUI mode (above). To debug an issue, you can run in debug mode (`--mode debug`) to see the browser while aws-azure-login tries to populate it. You can also have the tool print out more detail on what it is doing. aws-azure-login uses the [Node debug module](https://www.npmjs.com/package/debug) to print out debug info. Just set the DEBUG environmental variable to 'aws-azure-login'. On Linux/macOS:

    DEBUG=aws-azure-login aws-azure-login

On Windows:

    set DEBUG=aws-azure-login
    aws-azure-login

### Using a specific browser executable

By default aws-azure-login uses the Chromium bundled with Playwright. To use a different browser (e.g. system Chrome):

    PLAYWRIGHT_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" aws-azure-login --mode gui --profile ops

For backwards compatibility the old Puppeteer variable also works:

    PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" aws-azure-login --mode gui --profile ops

### Stale browser profile

If you see an error like "Opening in existing browser session", a previous run may have left lock files in the profile directory. Remove them:

    rm -f ~/.aws/chromium/SingletonLock ~/.aws/chromium/SingletonSocket ~/.aws/chromium/SingletonCookie

## Support for Other Authentication Providers

Obviously, this tool only supports Azure AD as an identity provider. However, there is a lot of similarity with how other logins with other providers would work (especially if they are SAML providers). If you are interested in building support for a different provider let me know. It would be great to build a more generic AWS CLI login tool with plugins for the various providers.
