import axios, { AxiosError } from 'axios';
import config from '../config';
import logger from '../config/logger';

const bcClient = axios.create({
    baseURL: config.bc.apiBaseUrl,
    headers: {
        'X-Auth-Token': config.bc.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
    },
    timeout: 10000,
});

bcClient.interceptors.response.use(
    res => res,
    (err: AxiosError<{ title?: string }>) => {
        const status = err.response?.status;
        const message = err.response?.data?.title ?? err.message;
        logger.error(`BC API error [${status}]: ${message}`);
        return Promise.reject(err);
    }
);

export default bcClient;
