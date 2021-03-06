# node-PalletTown

This project is inspired on [PalletTown](https://github.com/novskey/PalletTown),
which is a tool to create PTC accounts.

The main purpose of this is the same as the original one, but it's made on NodeJS,
only for fun purposes.

## Functionalities

- [ ] Account creation
- [x] Account validation

### Prerequisites

- Node.js
- Selenium
- Webdriver (ChromeDriver, PhantomJS, etc...)

### Current status

Right now this project only verifies the accounts, you still need to manually
create the accounts, or use [Kinan City](https://github.com/drallieiv/KinanCity).
Account creation is on the roadmap, should be done soon.

### Account validation

As this tool connect through IMAP, it should work on any email host platform, as
Gmail or Hotmail. During the development, I only tested on Gmail with a custom
domain.

To start the email validation, run the following command:
```
npm run verify
```

It should take a little bit to mark all emails as read, if you have a large number
of emails. To see what the command is doing, set the `verbosity` to `debug` on
your config file.

## Configuration

Copy `config/default.dist.json` to `config/default.json` and edit as appropriate.
