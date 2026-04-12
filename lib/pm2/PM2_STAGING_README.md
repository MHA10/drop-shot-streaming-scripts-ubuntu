# PM2 Staging Setup

This guide explains how to initiate and manage the staging Node.js service using PM2 and the provided `run-staging.sh` script.

## 1. Prerequisites

- Make sure `pm2` is installed globally on your machine:
  ```bash
  npm install -g pm2
  ```
- Ensure the execution script has the necessary permissions to run:
  ```bash
  chmod +x /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/lib/pm2/run-staging.sh
  ```

## 2. Initiating the Staging Service

To start the application using the script, run the following PM2 command. You can adjust the `--name` parameter as needed.

```bash
pm2 start /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/lib/pm2/run-staging.sh --name "dropshot-staging"
```

*Note: Since the script explicitly navigates to `/home/ds/Documents/drop-shot-streaming-scripts-ubuntu/` and executes `npm run dev`, PM2 will run those instructions inside its managed context.*

## 3. Useful PM2 Commands

Once the staging service is up and running, you can manage it with these helpful commands:

- **View Live Logs:**
  ```bash
  pm2 logs dropshot-staging
  ```
  *To see only the last 100 lines:* `pm2 logs dropshot-staging --lines 100`

- **Open the Monitoring Dashboard:**
  ```bash
  pm2 monit
  ```

- **Restart the Service:**
  ```bash
  pm2 restart dropshot-staging
  ```

- **Stop the Service:**
  ```bash
  pm2 stop dropshot-staging
  ```

- **Remove the Service from PM2:**
  ```bash
  pm2 delete dropshot-staging
  ```

## 4. Persisting the Service Across Reboots

To ensure that your staging application automatically starts whenever the system restarts:

1. Create a startup script suited for your operating system:
   ```bash
   pm2 startup
   ```
   *Action Required: Execute the command that PM2 generates and prints to your terminal.*

2. Save your currently running PM2 processes so they are restored upon reboot:
   ```bash
   pm2 save
   ```
